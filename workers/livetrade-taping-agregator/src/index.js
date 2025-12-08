// workers/livetrade-taping-agregator/src/index.js
import { DurableObject } from "cloudflare:workers";

export default {
  // Entry point HTTP Request
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/step-backfill") {
      return stepBackfill(env, url);
    }

    if (pathname === "/" || pathname === "") {
      return new Response(JSON.stringify({ name: "aggregator", status: "ok" }, null, 2));
    }

    return new Response("Not found", { status: 404 });
  },

  // Entry point CRON Trigger (Jalan Otomatis Tiap Menit)
  async scheduled(event, env, ctx) {
    console.log("⏰ CRON Triggered: Memulai Aggregasi Otomatis...");
    // Gunakan waitUntil agar worker tidak mati sebelum proses selesai
    ctx.waitUntil(runDailyCron(env));
  },
};

/**
 * FUNGSI BARU: Wrapper untuk menjalankan Backfill secara Loop di dalam Worker
 * Ini menggantikan tugas script Python "run_backfill.py" tapi versi server-side.
 */
async function runDailyCron(env) {
  // 1. Tentukan Tanggal Hari Ini (UTC)
  // Sesuaikan folder R2 Anda. Jika taping worker pakai UTC, gunakan UTC.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  console.log(`📅 Processing Date: ${dateStr}`);

  // 2. Loop "Step-by-Step" sampai selesai
  // Kita mulai dengan RESET=true untuk memastikan perhitungan ulang dari nol (mencegah double counting)
  let cursor = null;
  let isDone = false;
  let loopCount = 0;
  
  // Safety: Maksimal 20 loop per menit agar tidak timeout (20 * 1000 file = 20.000 file max)
  const MAX_LOOPS = 20; 

  while (!isDone && loopCount < MAX_LOOPS) {
    loopCount++;
    
    // Konstruksi URL Palsu untuk memanggil fungsi stepBackfill yang sudah ada
    // Kita gunakan LIMIT besar (misal 500) agar cepat selesai dalam 1x jalan
    let fakeUrlStr = `http://internal/step-backfill?date=${dateStr}&limit=500`;
    
    if (cursor) {
      fakeUrlStr += `&cursor=${encodeURIComponent(cursor)}`;
    } else {
      // Jika putaran pertama, paksa RESET agar state bersih
      fakeUrlStr += `&reset=true`;
    }

    const fakeUrl = new URL(fakeUrlStr);

    // Panggil logika utama
    // Kita await response-nya
    const res = await stepBackfill(env, fakeUrl);
    const data = await res.json();

    if (data.status === "PROGRESS") {
      console.log(`🔄 Loop ${loopCount}: Processed ${data.processed} files. Lanjut...`);
      cursor = data.next_cursor;
    } else if (data.status === "DONE") {
      console.log(`✅ Loop ${loopCount}: SELESAI! Total Item: ${data.total_items}`);
      isDone = true;
    } else if (data.status === "EMPTY") {
      console.log(`⚠️ Data kosong untuk tanggal ${dateStr}`);
      isDone = true;
    } else {
      console.error("❌ Unknown status:", data);
      isDone = true;
    }
  }
}

// ... (Sisanya: getTimeBucket dan stepBackfill BIARKAN SAMA PERSIS) ...

/**
 * Helper: Round time ke kelipatan 5 menit terdekat (format "HH:mm")
 * Menerima berbagai format timeRaw, akan di-normalisasi menjadi 6 digit (HHMMSS)
 */
function getTimeBucket(timeRaw) {
  // Buang semua non-digit, ambil 6 digit terakhir
  let cleaned = String(timeRaw).replace(/\D/g, "");
  if (!cleaned) cleaned = "000000";
  if (cleaned.length > 6) cleaned = cleaned.slice(-6);
  const str = cleaned.padStart(6, "0");

  let hh = parseInt(str.substring(0, 2), 10);
  let mm = parseInt(str.substring(2, 4), 10);

  // Round up ke kelipatan 5 menit terdekat
  const remainder = mm % 5;
  if (remainder !== 0) {
    mm = mm + (5 - remainder);
  }
  if (mm >= 60) {
    mm = 0;
    hh += 1;
  }

  const hStr = String(hh).padStart(2, "0");
  const mStr = String(mm).padStart(2, "0");
  return `${hStr}:${mStr}`;
}

/**
 * LOGIC UTAMA BACKFILL
 */
async function stepBackfill(env, url) {
  const dateParam = url.searchParams.get("date");
  const cursor = url.searchParams.get("cursor");
  const reset = url.searchParams.get("reset");

  // 1) PARAM LIMIT
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!limit || Number.isNaN(limit)) limit = 250;

  if (!dateParam) {
    return new Response("Error: Butuh param ?date=YYYY-MM-DD", {
      status: 400,
    });
  }

  const [y, m, d] = dateParam.split("-");
  const prefix = `raw_lt/${y}/${m}/${d}/`;
  const tempFile = `temp_state_${dateParam}.json`;

  // 2) LOAD STATE LAMA (KECUALI RESET)
  let stats = {};
  if (!reset) {
    const existing = await env.DATA_LAKE.get(tempFile);
    if (existing) {
      try {
        stats = await existing.json();
      } catch (e) {
        stats = {};
      }
    }
  }

  // 3) LIST FILE R2
  const listParams = { prefix, limit };
  if (cursor) listParams.cursor = cursor;

  const listed = await env.DATA_LAKE.list(listParams);

  if (listed.objects.length === 0 && !cursor) {
    return new Response(
      JSON.stringify(
        { status: "EMPTY", message: "Tidak ada data." },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // 4) BACA FILE PARALEL
  const contents = await Promise.all(
    listed.objects.map((obj) =>
      env.DATA_LAKE.get(obj.key).then((r) => r.text())
    )
  );

  contents.forEach((content) => {
    const text = content.trim();
    if (!text) return;

    const lines = text.split("\n");
    lines.forEach((line) => {
      try {
        const json = JSON.parse(line);
        const parts = json.raw.split("|");

        // Struktur: 0=?, 1=time(HHMMSS), 2=?, 3=kode, 4=papan, 6=harga, 7=vol, ...
        const timeRaw = parts[1]; // ✅ timestamp dari raw
        const kode = parts[3];
        const papan = parts[4];
        const harga = parseInt(parts[6], 10);
        const vol = parseInt(parts[7], 10);

        if (Number.isNaN(harga) || Number.isNaN(vol) || papan !== "RG") return;

        // Init Emiten
        if (!stats[kode]) {
          stats[kode] = {
            open_day: 0,
            high_day: 0,
            low_day: null,
            totalVol: 0,
            freq: 0,
            // Tick rule state
            lastPrice: null,
            lastDir: 0,
            netVol: 0,      // Σ dir * vol
            buckets: {},
          };
        }

        const s = stats[kode];

        // Open hari
        if (s.open_day === 0) s.open_day = harga;

        // High / Low harian
        if (harga > s.high_day) s.high_day = harga;
        if (s.low_day == null || harga < s.low_day) s.low_day = harga;

        // Volume & frekuensi harian
        s.totalVol += vol;
        s.freq += 1;

        // Tick rule untuk net_vol (mirip pipeline lama)
        let dir = 0;
        if (s.lastPrice == null) {
          dir = 0; // trade pertama: tidak mempengaruhi netVol
        } else if (harga > s.lastPrice) {
          dir = 1;
        } else if (harga < s.lastPrice) {
          dir = -1;
        } else {
          dir = s.lastDir || 0;
        }

        s.netVol += dir * vol;
        s.lastPrice = harga;
        s.lastDir = dir;

        // Bucketing 5 Menit
        const bucketTime = getTimeBucket(timeRaw);

        if (!s.buckets[bucketTime]) {
          s.buckets[bucketTime] = {
            close: harga,
            vol: 0,
            netVol: 0,      // ⬅️ net volume per bucket (tick rule)
            valBucket: 0,   // ⬅️ optional: value per bucket (lot * price * 100)
          };
        }

        const b = s.buckets[bucketTime];
        b.vol += vol;
        b.close = harga;
        b.netVol += dir * vol;          // ⬅️ pakai dir dari tick rule harian
        b.valBucket += vol * harga * 100; // ⬅️ value per bucket

      } catch (e) {
        // skip line error
      }
    });
  });

  // 5) FINALISASI / PAGING
  const hasMore = listed.truncated;
  const nextCursor = listed.cursor;

  if (hasMore) {
    // Simpan progress sementara
    await env.DATA_LAKE.put(tempFile, JSON.stringify(stats));
    return new Response(
      JSON.stringify(
        {
          status: "PROGRESS",
          processed: listed.objects.length,
          next_cursor: nextCursor,
          limit_used: limit,
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // 6) SEMUA FILE HABIS -> DATA MATANG (ARRAY HISTORY)
  // 6) SEMUA FILE HABIS -> DATA MATANG (ARRAY HISTORY)
  const finalOutput = Object.keys(stats).map((kode) => {
    const s = stats[kode];
    const sortedTimes = Object.keys(s.buckets).sort();

    let cumVol = 0;
    let cumVal = 0;

    // Pakai range harian (high - low)
    const hasRange =
      s.high_day > 0 && s.low_day != null && s.high_day !== s.low_day;
    const dayRange = hasRange ? s.high_day - s.low_day : 0;

    // Profil quadran (buat iceberg / hidden acc)
    let q1 = 0, q2 = 0, q3 = 0, q4 = 0;
    let q4Vol = 0;
    let totalBuckets = 0;

    const timeline = sortedTimes.map((time) => {
      const b = s.buckets[time];

      const bucketVol = b.vol || 0;
      const bucketNetVol = b.netVol || 0;
      const bucketVal =
        b.valBucket || (bucketVol * b.close * 100); // fallback kalau valBucket belum ada

      cumVol += bucketVol;
      cumVal += bucketVal;

      // Momentum vs open day (sama seperti versi lama)
      const momentum =
        s.open_day > 0 ? ((b.close - s.open_day) / s.open_day) * 100 : 0;

      // Absorption: cumVol / (high - low). Jika range 0 → fallback ke cumVol
      const absorption = dayRange > 0 ? cumVol / dayRange : cumVol;

      // Money / Haka per bucket
      let moneyRaw = 0;
      if (bucketVol > 0) {
        moneyRaw = bucketNetVol / bucketVol; // -1 .. +1
      }
      const haka = (moneyRaw + 1) * 50;      // 0..100
      const xAxis = haka - 50;               // -50..+50

      // Profil quadran: X = xAxis, Y = momentum
      totalBuckets += 1;
      if (xAxis >= 0 && momentum >= 0) {
        q1++;
      } else if (xAxis < 0 && momentum >= 0) {
        q2++;
      } else if (xAxis < 0 && momentum < 0) {
        q3++;
      } else if (xAxis >= 0 && momentum < 0) {
        q4++;
        q4Vol += bucketVol;
      }

      return {
        t: time,                           // "HH:MM" (5-minute bucket)
        p: b.close,
        v: cumVal,                         // cumulative value sampai bucket ini
        dv: bucketVal,                     // value per bucket → bubble size
        m: Number(momentum.toFixed(2)),    // momentum bucket
        a: Number(absorption.toFixed(1)),  // absorption
        haka: Number(haka.toFixed(1)),     // %Haka per bucket
        x: Number(xAxis.toFixed(1)),       // X axis = haka - 50
      };
    });

    const lastPoint = timeline[timeline.length - 1] || {};

    const openDay = s.open_day || lastPoint.p || 0;
    const closeDay = lastPoint.p || openDay;
    const highDay = s.high_day || closeDay;
    const lowDay = s.low_day ?? closeDay;
    const totalVol = s.totalVol;
    const freq = s.freq;
    const netVol = s.netVol;

    // money_flow = net_vol / totalVol
    const moneyFlow = totalVol > 0 ? netVol / totalVol : 0;

    // Profil iceberg / hidden accumulation
    const totalQ = q1 + q2 + q3 + q4 || 1;
    const q4Ratio = q4 / totalQ;
    const volBias = totalVol > 0 ? q4Vol / totalVol : 0;
    const buyBias = moneyFlow > 0 ? moneyFlow : 0;

    const hiddenAccScore = Number(
      (q4Ratio * volBias * buyBias).toFixed(4)
    );

    return {
      kode,
      mode: "swing",

      // Daily summary di TOP LEVEL (tetap compat dengan versi lama)
      open: openDay,
      close: closeDay,
      high: highDay,
      low: lowDay,
      vol: totalVol,
      freq,
      net_vol: netVol,
      money_flow: Number(moneyFlow.toFixed(4)),
      momentum: lastPoint.m ?? 0,
      absorption: lastPoint.a ?? 0,
      val: lastPoint.v ?? 0,

      // Profil quadran & hidden accumulation untuk swing
      quadrant_profile: {
        q1,
        q2,
        q3,
        q4,
        q4_ratio: Number(q4Ratio.toFixed(3)),
      },
      hidden_acc_score: hiddenAccScore,

      // Time series 5-menit (buat chart 4 kuadran)
      history: timeline,
    };
  });


  if (finalOutput.length === 0) {
    await env.DATA_LAKE.delete(tempFile).catch(() => { });
    return new Response(
      JSON.stringify({ status: "DONE", total_items: 0 }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Simpan JSON Matang ke R2
  await env.DATA_LAKE.put("snapshot_latest.json", JSON.stringify(finalOutput));
  await env.DATA_LAKE.put(
    `processed/${dateParam}.json`,
    JSON.stringify(finalOutput)
  );
  await env.DATA_LAKE.delete(tempFile).catch(() => { });

  // Push ke STATE_ENGINE
  try {
    const id = env.STATE_ENGINE.idFromName("GLOBAL_STATE");
    const stub = env.STATE_ENGINE.get(id);

    await stub.fetch("https://internal/bulk-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "swing",
        items: finalOutput,
      }),
    });
  } catch (err) {
    console.error("Failed to push to STATE_ENGINE", err);
  }

  return new Response(
    JSON.stringify(
      {
        status: "DONE",
        total_items: finalOutput.length,
        message: "Selesai!",
      },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json" } }
  );
}
