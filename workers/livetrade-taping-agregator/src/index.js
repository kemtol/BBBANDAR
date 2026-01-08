// workers/livetrade-taping-agregator/src/index.js
const BACKFILL_STATE_PREFIX = "backfill_state_";

// WIB = UTC+7, market closed setelah 15:15 WIB
function isMarketClosedWIB(nowUtc) {
  const wibMs = nowUtc.getTime() + 7 * 60 * 60 * 1000;
  const wib = new Date(wibMs);

  const hh = wib.getUTCHours();
  const mm = wib.getUTCMinutes();

  // closed kalau sudah lewat / sama dengan 15:15 WIB
  if (hh > 15) return true;
  if (hh === 15 && mm >= 15) return true;
  return false;
}

// ==============================
// REGEX PARSER UNTUK raw_lt
// ==============================
// Asumsi line: {"ts":..., "raw":"20251209|090001|...|RG|..."}
const REGEX_RAW = /"raw"\s*:\s*"([^"]+)"/;
// Kalau suatu saat kamu butuh ts:
const REGEX_TS = /"ts"\s*:\s*(\d+)/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Cron-checker integration endpoints
    if (request.method === "POST" && pathname === "/run") {
      try {
        const force = url.searchParams.get("force") === "1";
        const dateOverride = url.searchParams.get("date"); // e.g., "2026-01-07"
        console.log(`ðŸš€ /run endpoint triggered (force=${force}, date=${dateOverride || 'today'})`);
        await runDailyCron(env, force, dateOverride);
        // TODO: Add compression logic

        return Response.json({
          ok: true,
          message: "Aggregation completed",
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error("Error in /run:", error);
        return Response.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }
    }

    if (request.method === "POST" && pathname === "/queue-start") {
      const dateOverride = url.searchParams.get("date");
      const now = new Date();
      let dateStr = dateOverride;
      if (!dateStr) {
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        dateStr = `${y}-${m}-${d}`;
      }

      const job = {
        date: dateStr,
        cursor: null, // Start from beginning
        limit: 2000,
        force: true
      };

      await env.BACKFILL_QUEUE.send(job);
      return Response.json({ ok: true, message: "Job pushed to queue", job });
    }

    if (request.method === "GET" && pathname === "/schedule") {
      return Response.json({
        ok: true,
        worker: 'livetrade-taping-agregator',
        schedule: {
          interval: '1h',
          cron_expression: '0 * * * *'
        }
      });
    }

    if (pathname === "/step-backfill") {
      return stepBackfill(env, url);
    }

    if (pathname === "/signal-realtime") {
      return realtimeSignal(env, url);
    }

    // Verify integrity endpoint
    if (pathname === "/verify-integrity") {
      const date = url.searchParams.get("date");
      if (!date) {
        return Response.json({ ok: false, error: "Missing date param" }, { status: 400 });
      }
      try {
        const result = await compressRawLtForDate(env, date);
        return Response.json({ ok: true, result });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && pathname === "/test-delete") {
      const retention = parseInt(url.searchParams.get("retention") || "7", 10);
      const dryRun = url.searchParams.get("dryRun") === "true";

      try {
        if (dryRun) {
          return Response.json({
            ok: true,
            message: "Dry-run mode - use dryRun=false to actually delete",
            retention
          });
        }
        const result = await deleteOldRawLt(env, retention);
        return Response.json({ ok: true, result });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    if (pathname === "/" || pathname === "") {
      return new Response(
        JSON.stringify({ name: "aggregator", status: "ok" }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log("â° CRON Triggered: Memulai Aggregasi Otomatis...");
    ctx.waitUntil(runDailyCron(env));
  },

  async queue(batch, env) {
    console.log(`ðŸ“¥ Queue Batch Received: ${batch.messages.length} messages`);
    for (const msg of batch.messages) {
      try {
        const job = msg.body; // { date, cursor, limit, force }
        console.log(`ðŸ§± Processing Queue Job: date=${job.date}, cursor=${job.cursor}`);

        // Construct fake URL for stepBackfill
        const fakeUrl = new URL("http://internal/step-backfill");
        if (job.date) fakeUrl.searchParams.set("date", job.date);
        if (job.cursor) fakeUrl.searchParams.set("cursor", job.cursor);
        if (job.limit) fakeUrl.searchParams.set("limit", String(job.limit));
        // Force always applied via logic below or separate param

        await stepBackfill(env, fakeUrl, true); // true = isQueue mode

        msg.ack(); // Successful processing
      } catch (err) {
        console.error("âŒ Queue Job Failed:", err);
        msg.retry(); // Retry automatically
      }
    }
  },
};
async function runDailyCron(env, force = false, dateOverride = null) {
  const now = new Date();
  const marketClosed = isMarketClosedWIB(now);

  let dateStr;
  if (dateOverride) {
    dateStr = dateOverride; // Use provided date
  } else {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    dateStr = `${y}-${m}-${d}`;
  }
  console.log(`ðŸ“… CRON Processing Date: ${dateStr} (marketClosed=${marketClosed}, force=${force})`);

  const stateKey = `${BACKFILL_STATE_PREFIX}${dateStr}.json`;
  let state = { cursor: null, done: false };

  const stored = await env.DATA_LAKE.get(stateKey);
  if (stored) {
    try {
      state = await stored.json();
    } catch (e) {
      console.error("âŒ Gagal parse state backfill, reset state:", e);
      state = { cursor: null, done: false };
    }
  }

  // Kalau sudah DONE dan market benar-benar tutup â†’ boleh skip total
  // KECUALI kalau force=true â†’ tetap jalankan
  if (state.done && marketClosed && !force) {
    console.log("âœ… Backfill hari ini sudah selesai & market closed, cron skip.");
    return;
  }

  // Kalau force DAN state sudah DONE â†’ reset untuk mulai lagi dari awal
  // Tapi hanya jika cursor masih null (belum mulai proses baru)
  if (force && state.done && !state.cursor) {
    console.log("âš ï¸ FORCE MODE: Resetting done flag to reprocess data");
    state.done = false;
    // cursor tetap null supaya pakai reset=true di stepBackfill
  }

  // Kalau state.done = true tapi market belum tutup (misal habis sesi 1 / break)
  // â†’ anggap belum final, lanjutkan lagi.
  if (state.done && !marketClosed) {
    console.log("âš ï¸ state.done=true tapi market belum tutup, reset flag done=false & cursor=null.");
    state.done = false;
    state.cursor = null; // supaya next call pakai reset=true
  }


  const params = new URLSearchParams();
  params.set("date", dateStr);

  // NAIKKAN LIMIT AGAR EOD CEPAT SELESAI
  params.set("limit", "10000");

  if (!state.cursor) {
    params.set("reset", "true");
  } else {
    params.set("cursor", state.cursor);
  }

  // âš ï¸ FLAG: cron minta TANPA snapshot di batch tengah
  // params.set("noSnapshot", "1"); // Disabled to save snapshot

  const fakeUrl = new URL(`http://internal/step-backfill?${params.toString()}`);

  const res = await stepBackfill(env, fakeUrl);
  const data = await res.json();

  if (data.status === "PROGRESS") {
    console.log(
      `ðŸ”„ Batch jalan. processed=${data.processed}, next_cursor=${data.next_cursor}`
    );
    state.cursor = data.next_cursor;
    state.done = false; // jelas belum selesai
    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else if (data.status === "DONE") {
    console.log(
      `âœ… stepBackfill DONE (batch terakhir) untuk ${dateStr}, total_items: ${data.total_items}`
    );
    state.cursor = null;

    if (marketClosed) {
      // HANYA kalau market tutup baru kita anggap EOD final
      state.done = true;
      console.log("âœ… Market closed â†’ tandai backfill hari ini FINAL.");

      // ðŸ—œï¸ COMPRESSION & CLEANUP - Run after successful aggregation
      console.log("ðŸ§¹ Starting post-aggregation cleanup...");

      // Compress YESTERDAY's data (safer than today)
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yY = yesterday.getUTCFullYear();
      const yM = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
      const yD = String(yesterday.getUTCDate()).padStart(2, "0");
      const yesterdayStr = `${yY}-${yM}-${yD}`;

      try {
        const compressResult = await compressRawLtForDate(env, yesterdayStr);
        console.log("ðŸ“¦ Compression result:", JSON.stringify(compressResult));
      } catch (err) {
        console.error("âŒ Compression failed:", err);
      }


      // Delete old raw_lt (7 days retention)
      try {
        const deleteResult = await deleteOldRawLt(env, 7);
        console.log("ðŸ—‘ï¸ Deletion result:", JSON.stringify(deleteResult));
      } catch (err) {
        console.error("âŒ Deletion failed:", err);
      }

      // ðŸ§¹ CLEANUP BACKFILL STATES
      try {
        const cleanupStateResult = await cleanupBackfillStates(env);
        console.log("ðŸ§¹ Backfill State Cleanup:", JSON.stringify(cleanupStateResult));
      } catch (err) {
        console.error("âŒ Backfill State Cleanup failed:", err);
      }
    } else {
      // Sesi 1 selesai / break / sesi 2 masih jalan â†’ jangan final
      state.done = false;
      console.log(
        "â¸ stepBackfill DONE tapi market belum closed â†’ akan lanjut kalau ada file baru (sesi berikutnya)."
      );
    }

    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else if (data.status === "EMPTY") {
    console.log(`âš ï¸ Tidak ada data untuk tanggal ${dateStr} (status EMPTY).`);
    state.cursor = null;

    if (marketClosed) {
      // Misal hari libur penuh â†’ boleh dianggap done
      state.done = true;
      console.log("ðŸ“„ Hari ini kosong & market closed â†’ tandai done.");
    } else {
      // Pagi sebelum market buka â†’ jangan di-mark done, biar cron cek lagi nanti
      state.done = false;
      console.log(
        "ðŸŒ… EMPTY tapi market belum closed â†’ akan cek lagi nanti (mungkin market belum buka)."
      );
    }

    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else {
    console.error("âŒ Unknown status dari stepBackfill:", data);
    // Jangan ubah done, tapi tetap simpan state terbaru
    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  }
}

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

// ======= MOMENTUM & INTENTION SCORING (SIMPLE) =======
function computeMomentumFromTrades(trades) {
  // trades: array { ts, raw }
  if (!trades || trades.length < 2) return 0;

  const parsePrice = (raw) => {
    const parts = String(raw).split("|");
    const h = parseInt(parts[6], 10);
    return Number.isNaN(h) ? null : h;
  };

  const firstValid = trades.find((t) => parsePrice(t.raw) !== null);
  const lastValid = [...trades].reverse().find((t) => parsePrice(t.raw) !== null);

  if (!firstValid || !lastValid) return 0;

  const p0 = parsePrice(firstValid.raw);
  const p1 = parsePrice(lastValid.raw);
  if (!p0 || !p1 || p0 === 0) return 0;

  // momentum sederhana: % change
  const pct = (p1 - p0) / p0;

  // clamp biar ga kebangetan
  const clamped = Math.max(-0.05, Math.min(0.05, pct)); // -5%..+5%

  // normalisasi ke -1..+1
  return clamped / 0.05;
}




// Helper: ambil objek-objek R2 paling recent untuk suatu prefix
async function listRecentObjects(env, prefix, maxObjects = 50, pageSize = 100) {
  let cursor = undefined;
  let all = [];

  while (true) {
    const opts = { prefix, limit: pageSize };
    if (cursor) opts.cursor = cursor;

    const listed = await env.DATA_LAKE.list(opts);

    if (listed.objects && listed.objects.length > 0) {
      all.push(...listed.objects);
    }

    if (!listed.truncated) break;     // sudah page terakhir
    cursor = listed.cursor;

    // kalau sudah numpuk banyak banget, cukup simpan ekornya saja
    if (all.length >= maxObjects * 3) break;
  }

  // Ambil ekor saja (yang paling baru)
  if (all.length > maxObjects) {
    all = all.slice(-maxObjects);
  }

  return all;
}

async function loadLatestTradesForKode(env, kode, maxTrades = 50) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const H = String(now.getUTCHours()).padStart(2, "0");

  const prefixesToTry = [
    `raw_lt/${y}/${m}/${d}/${H}/`,
    `raw_lt/${y}/${m}/${d}/`,
  ];

  const trades = [];

  for (const prefix of prefixesToTry) {
    // ambil objek PALING BARU, tapi dibatasi supaya ringan:
    const maxObjects = Math.max(10, Math.ceil(maxTrades / 5)); // kira2
    const objs = await listRecentObjects(env, prefix, maxObjects, 100);
    if (!objs || objs.length === 0) {
      continue;
    }

    for (const obj of objs) {
      const r = await env.DATA_LAKE.get(obj.key);
      const text = await r.text();
      const trimmed = text.trim();
      if (!trimmed) continue;

      const lines = trimmed.split("\n");
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          const raw = o.raw;
          if (!raw) continue;

          const parts = String(raw).split("|");
          if (parts.length < 8) continue;

          const kodeLine = parts[3];
          if (kodeLine !== kode) continue;

          const timeRaw = parts[1] || "000000";
          const hh = timeRaw.slice(0, 2) || "00";
          const mm = timeRaw.slice(2, 4) || "00";
          const ss = timeRaw.slice(4, 6) || "00";

          const tsFromRaw = Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
          const ts = Number.isFinite(tsFromRaw)
            ? tsFromRaw
            : (o.ts || Date.now());

          trades.push({ ts, raw });

          // kalau sudah cukup sample, stop cepat
          if (trades.length >= maxTrades) break;
        } catch {
          // skip line error
        }
      }
      if (trades.length >= maxTrades) break;
    }

    if (trades.length > 0) break;
  }

  if (trades.length === 0) return [];

  trades.sort((a, b) => a.ts - b.ts);
  return trades.slice(-maxTrades);
}

async function realtimeSignal(env, url) {
  try {
    const kode = (url.searchParams.get("kode") || "GOTO").toUpperCase();
    const lite = url.searchParams.get("lite") === "1";

    // 1. Ambil data LT (trades)
    const maxTrades = lite ? 40 : 100;
    const trades = await loadLatestTradesForKode(env, kode, maxTrades);

    // 2. Ambil OB snapshot hanya kalau mode FULL
    let obSnapshot = null;
    let intentionScore = 0;

    if (!lite) {
      try {
        const obResp = await env.ORDERBOOK_AGG.fetch(
          "https://internal/intention?kode=" + kode
        );
        if (obResp.ok) {
          const obData = await obResp.json();
          intentionScore = obData.intention_score || 0;
          obSnapshot = obData.snapshot || null; // kalau mau sekalian kirim snapshot ringkas
        }
      } catch (e) {
        console.warn("Gagal fetch intention dari worker OB:", e);
      }
    }

    // 3. Hitung volume & HAKA dari raw_lt
    let totalVol = 0;
    let buyVol = 0;
    let lastPrice = null;
    let lastTrade = null;

    for (const t of trades) {
      const rawLine = String(t.raw || "");
      const parts = rawLine.split("|");
      if (parts.length < 8) continue;

      const papan = parts[4];
      if (papan !== "RG") continue;

      const harga = Number(parts[6]);
      const vol = Number(parts[7]);
      if (!Number.isFinite(harga) || !Number.isFinite(vol)) continue;

      totalVol += vol;

      let dir = 0;
      if (lastPrice === null) {
        dir = 0;
      } else if (harga > lastPrice) {
        dir = 1;
      } else if (harga < lastPrice) {
        dir = -1;
      }

      if (dir > 0) {
        buyVol += vol;
      }

      lastPrice = harga;
      lastTrade = {
        ts: t.ts,
        price: harga,
        volume: vol,
        dir,
      };
    }

    const hakaRatio = totalVol > 0 ? buyVol / totalVol : 0.5;

    // 4. Momentum (dari trades)
    const momentumScore = computeMomentumFromTrades(trades); // -1..+1

    // 6. Fused signal
    const hakaNorm = (hakaRatio - 0.5) * 2; // 0.5 â†’ 0, 1 â†’ +1, 0 â†’ -1
    let fused = lite
      ? hakaNorm // mode ringan: pakai HAKA saja
      : 0.6 * hakaNorm + 0.4 * intentionScore;

    if (!Number.isFinite(fused)) fused = 0;

    let side = "NONE";
    if (fused > 0.2) side = "BUY";
    else if (fused < -0.2) side = "SELL";

    const payload = {
      status: "OK",
      kode,
      mode: lite ? "lite" : "full",

      haka_ratio: Number(hakaRatio.toFixed(3)),
      momentum_score: Number(momentumScore.toFixed(3)),
      intention_score: Number(intentionScore.toFixed(3)),
      fused_signal: Number(fused.toFixed(3)),
      side,

      sample_counts: {
        trades: totalVol,
        has_orderbook: !!obSnapshot,
      },
      last_trade: lastTrade,
      ob_snapshot: lite ? null : obSnapshot,

      debug: {
        trades_count: trades.length,
        first_ts: trades[0]?.ts || null,
        first_raw: trades[0]?.raw || null,
        last_ts: lastTrade?.ts || null,
        last_price: lastTrade?.price || null,
      },
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("realtimeSignal error:", err);
    return new Response(
      JSON.stringify({ status: "ERROR", message: String(err) }, null, 2),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

function buildFinalOutputFromStats(stats) {
  return Object.keys(stats).map((kode) => {
    const s = stats[kode];
    const sortedTimes = Object.keys(s.buckets).sort();

    let cumVol = 0;
    let cumVal = 0;

    // Pakai range harian (high - low)
    const hasRange =
      s.high_day > 0 && s.low_day != null && s.high_day !== s.low_day;
    const dayRange = hasRange ? s.high_day - s.low_day : 0;

    // Profil quadran (buat iceberg / hidden acc)
    let q1 = 0,
      q2 = 0,
      q3 = 0,
      q4 = 0;
    let q4Vol = 0;
    let totalBuckets = 0;

    const timeline = sortedTimes.map((time) => {
      const b = s.buckets[time];

      const bucketVol = b.vol || 0;
      const bucketNetVol = b.netVol || 0;
      const bucketVal = b.valBucket || bucketVol * b.close * 100;

      cumVol += bucketVol;
      cumVal += bucketVal;

      // Momentum vs open day
      const momentum =
        s.open_day > 0 ? ((b.close - s.open_day) / s.open_day) * 100 : 0;

      // Absorption: cumVol / (high - low). Jika range 0 â†’ fallback ke cumVol
      const absorption = dayRange > 0 ? cumVol / dayRange : cumVol;

      // Money / Haka per bucket
      let moneyRaw = 0;
      if (bucketVol > 0) {
        moneyRaw = bucketNetVol / bucketVol; // -1..+1
      }
      const haka = (moneyRaw + 1) * 50; // 0..100
      const xAxis = haka - 50; // -50..+50

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
        t: time, // "HH:MM"
        p: b.close,
        v: cumVal, // cumulative value sampai bucket ini
        dv: bucketVal, // value per bucket â†’ bubble size
        m: Number(momentum.toFixed(2)),
        a: Number(absorption.toFixed(1)),
        haka: Number(haka.toFixed(1)),
        x: Number(xAxis.toFixed(1)),
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

      quadrant_profile: {
        q1,
        q2,
        q3,
        q4,
        q4_ratio: Number(q4Ratio.toFixed(3)),
      },
      hidden_acc_score: hiddenAccScore,

      history: timeline,

      // âž• raw trade terakhir (kalau mau dipakai di UI)
      last_raw: s.lastRaw || null,
    };
  });
}

/**
 * LOGIC UTAMA BACKFILL
 * isQueue: jika true, fungsi ini tidak return Response tpi melakukan chain ke queue (atau throw error)
 */
async function stepBackfill(env, url, isQueue = false) {
  const dateParam = url.searchParams.get("date");
  const cursor = url.searchParams.get("cursor");
  const reset = url.searchParams.get("reset");
  const noSnapshot = url.searchParams.get("noSnapshot") === "1"; // â¬…ï¸ FLAG BARU

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
  const contents = await Promise.all(
    listed.objects.map((obj) =>
      env.DATA_LAKE.get(obj.key).then((r) => r.text())
    )
  );

  // Counter & sample logging
  let regexFailCount = 0;
  let legacyParseCount = 0;
  let diffCount = 0;
  let diffSampleLogged = 0;
  const MAX_LOG_SAMPLE = 10;       // berapa banyak contoh yang di-log
  //const MAX_DIFF_CHECK_SAMPLE = 50; // berapa banyak line pertama yang kita bandingkan dengan JSON.parse

  let diffCheckSeen = 0;

  const v2GlobalBatch = [];

  contents.forEach((content) => {
    const text = content.trim();
    if (!text) return;

    const lines = text.split("\n");

    lines.forEach((line) => {
      if (!line) return;

      try {
        let raw = null;

        // --- 1) Coba parse dengan REGEX (fast path) ---
        const matchRaw = line.match(REGEX_RAW);
        if (matchRaw) {
          raw = matchRaw[1];
        } else {
          // Regex gagal â†’ catat & coba fallback
          regexFailCount++;
          if (regexFailCount <= MAX_LOG_SAMPLE) {
            console.warn("âš ï¸ Regex RAW gagal parse line (sample):", line.slice(0, 200));
          }

          // --- 2) Fallback: coba format lama (JSON.parse) ---
          try {
            const objLegacy = JSON.parse(line);
            if (objLegacy && typeof objLegacy.raw === "string") {
              legacyParseCount++;
              raw = objLegacy.raw;

              if (legacyParseCount <= MAX_LOG_SAMPLE) {
                console.warn("â„¹ï¸ Line parsed via legacy JSON.parse (raw_lt lama).");
              }
            } else {
              // format lama pun aneh â†’ buang baris ini
              return;
            }
          } catch (eLegacy) {
            // regex + JSON.parse dua-duanya gagal â†’ skip baris busuk
            if (regexFailCount <= MAX_LOG_SAMPLE) {
              console.warn("âŒ Regex & JSON.parse gagal parse line (raw_lt):", line.slice(0, 200));
            }
            return;
          }
        }

        // --- 3) OPTIONAL: diff-check ke format lama untuk beberapa line awal ---
        /*if (diffCheckSeen < MAX_DIFF_CHECK_SAMPLE) {
          diffCheckSeen++;
          try {
            const objLegacy = JSON.parse(line);
            if (objLegacy && typeof objLegacy.raw === "string") {
              const legacyRaw = objLegacy.raw;
              if (legacyRaw !== raw) {
                diffCount++;
                if (diffSampleLogged < MAX_LOG_SAMPLE) {
                  diffSampleLogged++;
                  console.warn("âš ï¸ DIFF raw_lt: regex vs legacy berbeda.", {
                    regex_raw: raw.slice(0, 120),
                    legacy_raw: legacyRaw.slice(0, 120),
                  });
                }
              }
            }
          } catch {
          }
        }*/

        // --- 4) Dari sini ke bawah: logic statistik sama seperti sebelumnya ---
        const parts = String(raw).split("|");
        if (parts.length < 8) return; // jaga-jaga kalau line rusak

        const timeRaw = parts[1];
        const kode = parts[3];
        const papan = parts[4];
        const type = parts[5]; // Assuming parts[5] is the trade type/side
        const harga = Number(parts[6]);
        const vol = Number(parts[7]);

        if (Number.isNaN(harga) || Number.isNaN(vol) || papan !== "RG") return;

        if (!stats[kode]) {
          stats[kode] = {
            open_day: 0,
            high_day: 0,
            low_day: null,
            totalVol: 0,
            freq: 0,
            lastPrice: null,
            lastDir: 0,
            netVol: 0,
            buckets: {},
            lastRaw: null,
          };
        }

        const s = stats[kode];

        // ============================================
        // V2 PARALLEL DISPATCH (Batched)
        // ============================================
        if (env.STATE_ENGINE_V2) {
          // ... logic skipped for brevity if redundant, but here we accumulate ...
          const fullTs = `${dateParam}T${timeRaw}`;

          const v2Job = {
            ticker: kode,
            price: harga,
            amount: vol,
            side: (type === '1' || type === 1) ? 'buy' : 'sell',
            timestamp: new Date(fullTs).getTime()
          };
          if (v2GlobalBatch.length < 3) {
            console.log(`[DEBUG_SIDE] Ticker: ${kode}, Type: '${type}', Parsed: ${(type === '1' || type === 1) ? 'buy' : 'sell'}, Raw: ${raw}`);
          }
          v2GlobalBatch.push(v2Job);
        }

        // OHLC harian
        if (s.open_day === 0) s.open_day = harga;
        if (harga > s.high_day) s.high_day = harga;
        if (s.low_day == null || harga < s.low_day) s.low_day = harga;

        s.totalVol += vol;
        s.freq += 1;

        let dir = 0;
        if (s.lastPrice == null) {
          dir = 0;
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
        s.lastRaw = raw; // simpan raw hasil regex / legacy

        const bucketTime = getTimeBucket(timeRaw);

        if (!s.buckets[bucketTime]) {
          s.buckets[bucketTime] = {
            close: harga,
            vol: 0,
            netVol: 0,
            valBucket: 0,
          };
        }

        const b = s.buckets[bucketTime];
        b.vol += vol;
        b.close = harga;
        b.netVol += dir * vol;
        b.valBucket += vol * harga * 100;
      } catch (e) {
        // skip line error
      }

    }); // end lines.forEach

  }); // end contents.forEach

  // Flush V2 Batch (Global)
  if (v2GlobalBatch.length > 0 && env.STATE_ENGINE_V2) {
    try {
      const idV2 = env.STATE_ENGINE_V2.idFromName("GLOBAL_V2_ENGINE");
      const stubV2 = env.STATE_ENGINE_V2.get(idV2);
      // Fire and forget (await if strictly necessary, but catch handles error)
      stubV2.fetch("https://internal/batch-update", {
        method: "POST",
        body: JSON.stringify(v2GlobalBatch)
      }).catch(err => console.warn("V2 Global Batch Failed", err));
    } catch (errSync) {
      console.warn("V2 Global Batch Setup Failed", errSync);
    }
  }

  // Setelah semua file diproses, log summary parsing
  if (regexFailCount > 0 || legacyParseCount > 0 || diffCount > 0) {
    console.warn(
      `ðŸ“Š stepBackfill parse summary: regexFail=${regexFailCount}, legacyParse=${legacyParseCount}, diffRaw=${diffCount}`
    );
  }


  const hasMore = listed.truncated;
  const nextCursor = listed.cursor;
  // âš ï¸ MODE RINGAN: kalau noSnapshot = true, JANGAN build finalOutput sama sekali
  // if (noSnapshot) { ... } // DISABLED: Always save snapshot

  const status = hasMore ? "PROGRESS" : "DONE";

  // QUEUE LOGIC: If hasMore, push next task to queue
  if (isQueue && hasMore) {
    // Construct next job
    const job = {
      date: dateParam,
      cursor: nextCursor,
      limit: limit,
      force: true // Always force in queue to bypass checks
    };
    console.log(`ðŸ”„ Queue Chain: Sending next batch (cursor=${nextCursor})`);
    await env.BACKFILL_QUEUE.send(job);
    return; // Void return for queue consumer
  }

  if (isQueue && !hasMore) {
    console.log("âœ… Queue Job Done: No more data.");
    // Lanjut ke logic DONE di bawah (buildFinalOutput) untuk cleanup
  }

  if (!isQueue && noSnapshot) { // Legacy HTTP mode with noSnapshot
    // ... existing HTTP logic ...
    await env.DATA_LAKE.put(tempFile, JSON.stringify(stats));
    return new Response(JSON.stringify({
      status, processed: listed.objects.length, next_cursor: hasMore ? nextCursor : null, limit_used: limit
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }



  // Di sini hanya:
  // - batch terakhir dari cron (noSnapshot=true tapi hasMore=false), atau
  // - pemanggilan manual tanpa noSnapshot (misal HTTP)
  const finalOutput = buildFinalOutputFromStats(stats);

  if (hasMore) {
    await env.DATA_LAKE.put(tempFile, JSON.stringify(stats));
    await env.DATA_LAKE.put(
      "snapshot_latest.json",
      JSON.stringify(finalOutput)
    );

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
      console.error("Failed to push partial to STATE_ENGINE", err);
    }

    // ============================================
    // V2 PARALLEL DISPATCH (Double Write)
    // ============================================
    try {
      if (env.STATE_ENGINE_V2) {
        // We need to send parsed trades, not aggregated swings.
        // We have `parsed` items above (line 981).
        // Let's send them in batch or individually. DO expects single update or batch?
        // My DO impl handles `/update` with single trade object: { ticker, price, side, vol, timestamp }
        // Let's adapt `parsed` items which are { s, p, v, t, type }.

        // Optimization: Create a batch endpoint in DO V2 later. For now, Promise.all.
        // Actually, let's just fire and forget loop to avoid timeout.
        const idV2 = env.STATE_ENGINE_V2.idFromName("GLOBAL_V2_ENGINE");
        const stubV2 = env.STATE_ENGINE_V2.get(idV2);

        // Limit V2 concurrency/load for now?
        // Doing full dual-write might be heavy. Let's do it.
        const v2Promises = finalOutput.flatMap(item => {
          // Wait, `finalOutput` is aggregated swings. We want RAW TRADES `parsed`.
          // `parsed` variable is not available here scope-wise easily unless we look up.
          // Ah, `parsed` is inside the loop. 
          // Better strategy: We should do this INSIDE the `processRawFile` logic or iterate `parsed` array if accessible.
          // `listed.objects` loop processes files.
          // I will insert this logic deep inside the file processing loop.
          return [];
        });
      }
    } catch (errV2) {
      console.error("Failed dispatch V2", errV2);
    }

    // QUEUE LOGIC: If hasMore, push next task to queue
    if (isQueue) {
      const job = {
        date: dateParam,
        cursor: nextCursor,
        limit: limit,
        force: true
      };
      console.log(`ðŸ”„ Queue Chain: Sending next batch (middle of cron)`);
      await env.BACKFILL_QUEUE.send(job);
      return;
    }

    // HTTP Response
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

  // Batch terakhir â†’ FINAL EOD
  if (finalOutput.length === 0) {
    await env.DATA_LAKE.delete(tempFile).catch(() => { });
    return new Response(
      JSON.stringify({ status: "DONE", total_items: 0 }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  await env.DATA_LAKE.put("snapshot_latest.json", JSON.stringify(finalOutput));
  await env.DATA_LAKE.put(
    `processed/${dateParam}.json`,
    JSON.stringify(finalOutput)
  );
  await env.DATA_LAKE.delete(tempFile).catch(() => { });

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
    console.error("Failed to push final to STATE_ENGINE", err);
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

/**
 * Compress all raw_lt files for a specific date into a single gzipped file
 * @param {Object} env - Worker environment bindings
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Object} - Compression result with stats
 */
async function compressRawLtForDate(env, dateStr) {
  const [y, m, d] = dateStr.split('-');
  const prefix = `raw_lt/${y}/${m}/${d}/`;
  const outputKey = `raw_lt_compressed/${dateStr}.jsonl.gz`;

  console.log(`ðŸ—œï¸ Starting compression for ${dateStr}...`);

  // Check if already compressed
  const existing = await env.DATA_LAKE.head(outputKey);
  if (existing) {
    console.log(`âœ… Already compressed: ${outputKey}`);
    return { compressed: true, skipReason: 'already_exists', outputKey };
  }

  // List files with a reasonable limit to avoid API issues
  const MAX_FILES = 500; // Limit to avoid "Too many API requests" error
  const files = [];
  let cursor;
  let listCount = 0;
  const MAX_LIST_CALLS = 5; // Limit list operations

  do {
    const listed = await env.DATA_LAKE.list({ prefix, cursor, limit: 100 });
    files.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : null;
    listCount++;

    // Stop if we have enough files or made too many list calls
    if (files.length >= MAX_FILES || listCount >= MAX_LIST_CALLS) {
      console.log(`âš ï¸ Reached limit: ${files.length} files listed in ${listCount} calls`);
      break;
    }
  } while (cursor);

  if (files.length === 0) {
    console.log(`âš ï¸ No files to compress for ${dateStr}`);
    return { compressed: false, skipReason: 'no_files' };
  }

  // Fetch and concatenate files (limit to MAX_FILES to avoid memory/API issues)
  const filesToProcess = files.slice(0, MAX_FILES);
  const allLines = [];
  let originalSize = 0;

  for (const file of filesToProcess) {
    const obj = await env.DATA_LAKE.get(file.key);
    const text = await obj.text();
    const trimmed = text.trim();
    if (trimmed) {
      allLines.push(trimmed);
    }
    originalSize += file.size;
  }

  const combined = allLines.join('\n');

  // Compress using CompressionStream and collect into ArrayBuffer
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(combined));
      controller.close();
    }
  });

  const compressedStream = stream.pipeThrough(
    new CompressionStream('gzip')
  );

  // Collect stream into buffer
  const reader = compressedStream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine chunks into single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const compressedData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    compressedData.set(chunk, offset);
    offset += chunk.length;
  }

  // Upload compressed file with known length
  await env.DATA_LAKE.put(outputKey, compressedData, {
    httpMetadata: {
      contentType: 'application/gzip'
    }
  });

  const compressedSize = compressedData.length;
  const compressionRatio = Math.round((compressedSize / originalSize) * 100);

  console.log(`âœ… Compressed ${dateStr}: ${files.length} files, ${originalSize}â†’${compressedSize} bytes (${compressionRatio}%)`);

  return {
    compressed: true,
    fileCount: files.length,
    originalSize,
    compressedSize,
    compressionRatio,
    outputKey
  };
}

/**
 * Delete raw_lt folders older than retentionDays
 * @param {Object} env - Worker environment bindings  
 * @param {number} retentionDays - Keep data for this many days
 * @returns {Object} - Deletion result with stats
 */
async function deleteOldRawLt(env, retentionDays = 7) {
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const cutoffY = cutoffDate.getUTCFullYear();
  const cutoffM = String(cutoffDate.getUTCMonth() + 1).padStart(2, '0');
  const cutoffD = String(cutoffDate.getUTCDate()).padStart(2, '0');
  const cutoffStr = `${cutoffY}-${cutoffM}-${cutoffD}`;

  console.log(`ðŸ—‘ï¸ Deleting raw_lt older than ${cutoffStr} (${retentionDays} days retention)`);

  // List all files in raw_lt with date-based filtering
  const toDelete = [];
  const datesFound = new Set();
  let cursor;

  do {
    const listed = await env.DATA_LAKE.list({
      prefix: 'raw_lt/',
      cursor,
      limit: 1000
    });

    for (const obj of listed.objects) {
      // Parse date from path: raw_lt/YYYY/MM/DD/...
      const match = obj.key.match(/^raw_lt\/(\d{4})\/(\d{2})\/(\d{2})\//);
      if (!match) continue;

      const [_, y, m, d] = match;
      const fileDate = `${y}-${m}-${d}`;
      datesFound.add(fileDate);

      // Only delete if older than cutoff
      if (fileDate < cutoffStr) {
        toDelete.push(obj.key);
      }
    }

    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);

  if (toDelete.length === 0) {
    console.log(`âœ… No old files to delete (found dates: ${Array.from(datesFound).sort()})`);
    return { deleted: false, fileCount: 0, cutoffDate: cutoffStr, skipReason: 'no_old_files' };
  }

  // Delete in batches
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = toDelete.slice(i, i + batchSize);
    await Promise.all(batch.map(key =>
      env.DATA_LAKE.delete(key).catch(err =>
        console.error(`Failed to delete ${key}:`, err)
      )
    ));
    deleted += batch.length;
  }

  console.log(`âœ… Deleted ${deleted} old raw_lt files (cutoff: ${cutoffStr})`);

  return {
    deleted: true,
    fileCount: deleted,
    cutoffDate: cutoffStr,
    datesDeleted: Array.from(datesFound).filter(d => d < cutoffStr).sort()
  };
}

/**
 * Cleanup old backfill_state_*.json files
 * Keep only the most recent one (or two), delete the rest via Batch Delete Worker
 */
async function cleanupBackfillStates(env) {
  const prefix = BACKFILL_STATE_PREFIX; // "backfill_state_"

  // 1. List all state files
  const listed = await env.DATA_LAKE.list({ prefix });
  const allFiles = listed.objects;

  if (allFiles.length <= 1) {
    return { skipped: true, reason: "Not enough files to clean (<= 1)", count: allFiles.length };
  }

  // 2. Sort by uploaded time (descending) -> newest first
  // key format: backfill_state_YYYY-MM-DD.json
  // We can also sort by key since YYYY-MM-DD is lexicographically sortable
  allFiles.sort((a, b) => b.key.localeCompare(a.key));

  // 3. Keep the newest 2 files (active today + maybe yesterday) just to be safe
  const KEEP_COUNT = 2;
  const toDelete = allFiles.slice(KEEP_COUNT);

  if (toDelete.length === 0) {
    return { skipped: true, reason: "No old files to delete", count: allFiles.length };
  }

  const keysToDelete = toDelete.map(o => o.key);
  console.log(`ðŸ§¹ Found ${keysToDelete.length} old backfill states to delete:`, keysToDelete);

  // 4. Send to Batch Delete Worker
  if (!env.BATCH_DELETE) {
    console.warn("âš ï¸ BATCH_DELETE binding missing, falling back to manual delete");
    // Fallback: manual delete one by one
    let deletedCount = 0;
    for (const key of keysToDelete) {
      await env.DATA_LAKE.delete(key);
      deletedCount++;
    }
    return { manual: true, deleted: deletedCount };
  }

  try {
    const resp = await env.BATCH_DELETE.fetch("https://batch-delete/delete-keys?bucket=saham", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: keysToDelete })
    });

    const resJson = await resp.json();
    return {
      success: resp.ok,
      worker_response: resJson,
      deleted_keys: keysToDelete.length
    };
  } catch (err) {
    throw new Error(`Failed to call BATCH_DELETE: ${err.message}`);
  }
}

