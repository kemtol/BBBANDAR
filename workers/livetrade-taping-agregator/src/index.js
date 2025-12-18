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
        console.log("🚀 /run endpoint triggered by cron-checker");
        await runDailyCron(env);
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

    // Verify integrity endpoint - compare compressed vs raw_lt
    if (request.method === "GET" && pathname === "/verify-integrity") {
      try {
        const date = url.searchParams.get("date");
        if (!date) {
          return Response.json({ error: "Missing ?date=YYYY-MM-DD" }, { status: 400 });
        }

        const [y, m, d] = date.split('-');
        const compressedKey = `raw_lt_compressed/${date}.jsonl.gz`;
        const rawPrefix = `raw_lt/${y}/${m}/${d}/`;

        // Check if compressed file exists
        const compressed = await env.DATA_LAKE.get(compressedKey);
        if (!compressed) {
          return Response.json({
            ok: false,
            error: "Compressed file not found",
            compressedKey,
            verified: false
          });
        }

        // Decompress and parse
        const decompStream = compressed.body.pipeThrough(new DecompressionStream('gzip'));
        const decompText = await new Response(decompStream).text();
        const compressedLines = decompText.trim().split('\n');

        // Sample random lines from raw_lt
        const rawSamples = [];
        const sampleCount = 10; // Sample 10 random files

        const listed = await env.DATA_LAKE.list({ prefix: rawPrefix, limit: 100 });
        if (listed.objects.length === 0) {
          return Response.json({
            ok: false,
            error: "No raw files found",
            rawPrefix,
            verified: false
          });
        }

        // Pick random files
        const randomFiles = [];
        for (let i = 0; i < Math.min(sampleCount, listed.objects.length); i++) {
          const randomIndex = Math.floor(Math.random() * listed.objects.length);
          randomFiles.push(listed.objects[randomIndex]);
        }

        for (const file of randomFiles) {
          const obj = await env.DATA_LAKE.get(file.key);
          const text = await obj.text();
          const lines = text.trim().split('\n');
          rawSamples.push(...lines.slice(0, 3)); // 3 lines per file
        }

        // Check if samples exist in compressed
        let matchCount = 0;
        for (const sample of rawSamples) {
          if (compressedLines.includes(sample)) {
            matchCount++;
          }
        }

        const matchRatio = rawSamples.length > 0 ? matchCount / rawSamples.length : 0;
        const verified = matchRatio >= 0.8; // 80% match threshold

        return Response.json({
          ok: true,
          date,
          verified,
          compressedLines: compressedLines.length,
          sampledLines: rawSamples.length,
          matchedLines: matchCount,
          matchRatio: Number(matchRatio.toFixed(2)),
          threshold: 0.8,
          status: verified ? "PASS" : "FAIL",
          message: verified ?
            "Integrity verified - safe to delete raw files" :
            "Integrity check failed - DO NOT delete raw files"
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message, verified: false }, { status: 500 });
      }
    }

    // Force delete for specific date - FIXED VERSION with limits
    if (request.method === "POST" && pathname === "/force-delete-date") {
      try {
        const date = url.searchParams.get("date");
        if (!date) {
          return Response.json({ error: "Missing ?date=YYYY-MM-DD" }, { status: 400 });
        }

        const maxDelete = parseInt(url.searchParams.get("max") || "1000", 10); // Limit per invocation
        const [y, m, d] = date.split('-');
        const prefix = `raw_lt/${y}/${m}/${d}/`;

        console.log(`🗑️ Force deleting up to ${maxDelete} files from: ${prefix}`);

        let deleted = 0;
        let cursor;
        let totalListed = 0;

        // List and delete in batches
        outer: do {
          const listed = await env.DATA_LAKE.list({ prefix, cursor, limit: 100 });
          totalListed += listed.objects.length;

          // Delete files ONE BY ONE (not parallel)
          for (const obj of listed.objects) {
            if (deleted >= maxDelete) {
              console.log(`⚠️ Reached max deletion limit: ${maxDelete}`);
              break outer;
            }

            try {
              await env.DATA_LAKE.delete(obj.key);
              deleted++;
              if (deleted % 100 === 0) {
                console.log(`Progress: ${deleted} files deleted...`);
              }
            } catch (err) {
              console.error(`Failed to delete ${obj.key}:`, err.message);
            }
          }

          cursor = listed.truncated ? listed.cursor : null;
        } while (cursor && deleted < maxDelete);

        console.log(`✅ Deletion complete: ${deleted} files deleted from ${prefix}`);

        return Response.json({
          ok: true,
          deleted,
          prefix,
          date,
          maxLimit: maxDelete,
          reachedLimit: deleted >= maxDelete,
          message: deleted >= maxDelete ?
            `Deleted ${deleted} files (limit reached). Call again to continue.` :
            `Deleted ${deleted} files (all done).`
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // Inspection endpoint - list what's in raw_lt
    if (request.method === "GET" && pathname === "/inspect-raw-lt") {
      try {
        const dateMap = new Map();
        let cursor;
        let totalFiles = 0;
        const limit = parseInt(url.searchParams.get("limit") || "2000", 10);

        do {
          const listed = await env.DATA_LAKE.list({
            prefix: 'raw_lt/',
            cursor,
            limit: 100
          });

          for (const obj of listed.objects) {
            const match = obj.key.match(/^raw_lt\/(\d{4})\/(\d{2})\/(\d{2})\//);
            if (match) {
              const [_, y, m, d] = match;
              const dateKey = `${y}-${m}-${d}`;
              dateMap.set(dateKey, (dateMap.get(dateKey) || 0) + 1);
              totalFiles++;
            }
          }

          cursor = listed.truncated ? listed.cursor : null;

          if (totalFiles >= limit) break;
        } while (cursor);

        const dates = Array.from(dateMap.entries())
          .map(([date, count]) => ({ date, fileCount: count }))
          .sort((a, b) => a.date.localeCompare(b.date));

        return Response.json({
          ok: true,
          totalFiles,
          dateCount: dates.length,
          dates,
          oldest: dates[0]?.date,
          newest: dates[dates.length - 1]?.date
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // Test endpoints for compression and deletion
    if (request.method === "POST" && pathname === "/test-compress") {
      const date = url.searchParams.get("date");
      if (!date) {
        return Response.json({ error: "Missing ?date=YYYY-MM-DD" }, { status: 400 });
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
            retention,
            note: "Actual deletion not implemented in dry-run, use live endpoint"
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
    console.log("⏰ CRON Triggered: Memulai Aggregasi Otomatis...");
    ctx.waitUntil(runDailyCron(env));
  },
};

async function runDailyCron(env) {
  const now = new Date();
  const marketClosed = isMarketClosedWIB(now);

  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${d}`;
  console.log(`📅 CRON Processing Date: ${dateStr} (marketClosed=${marketClosed})`);

  const stateKey = `${BACKFILL_STATE_PREFIX}${dateStr}.json`;
  let state = { cursor: null, done: false };

  const stored = await env.DATA_LAKE.get(stateKey);
  if (stored) {
    try {
      state = await stored.json();
    } catch (e) {
      console.error("❌ Gagal parse state backfill, reset state:", e);
      state = { cursor: null, done: false };
    }
  }

  // Kalau sudah DONE dan market benar-benar tutup → boleh skip total
  if (state.done && marketClosed) {
    console.log("✅ Backfill hari ini sudah selesai & market closed, cron skip.");
    return;
  }

  // Kalau state.done = true tapi market belum tutup (misal habis sesi 1 / break)
  // → anggap belum final, lanjutkan lagi.
  if (state.done && !marketClosed) {
    console.log("⚠️ state.done=true tapi market belum tutup, reset flag done=false & cursor=null.");
    state.done = false;
    state.cursor = null; // supaya next call pakai reset=true
  }


  const params = new URLSearchParams();
  params.set("date", dateStr);

  // TURUNKAN LIMIT BIAR ENTENG
  params.set("limit", "250");

  if (!state.cursor) {
    params.set("reset", "true");
  } else {
    params.set("cursor", state.cursor);
  }

  // ⚠️ FLAG: cron minta TANPA snapshot di batch tengah
  params.set("noSnapshot", "1");

  const fakeUrl = new URL(`http://internal/step-backfill?${params.toString()}`);

  const res = await stepBackfill(env, fakeUrl);
  const data = await res.json();

  if (data.status === "PROGRESS") {
    console.log(
      `🔄 Batch jalan. processed=${data.processed}, next_cursor=${data.next_cursor}`
    );
    state.cursor = data.next_cursor;
    state.done = false; // jelas belum selesai
    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else if (data.status === "DONE") {
    console.log(
      `✅ stepBackfill DONE (batch terakhir) untuk ${dateStr}, total_items: ${data.total_items}`
    );
    state.cursor = null;

    if (marketClosed) {
      // HANYA kalau market tutup baru kita anggap EOD final
      state.done = true;
      console.log("✅ Market closed → tandai backfill hari ini FINAL.");

      // 🗜️ COMPRESSION & CLEANUP - Run after successful aggregation
      console.log("🧹 Starting post-aggregation cleanup...");

      // Compress YESTERDAY's data (safer than today)
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yY = yesterday.getUTCFullYear();
      const yM = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
      const yD = String(yesterday.getUTCDate()).padStart(2, "0");
      const yesterdayStr = `${yY}-${yM}-${yD}`;

      try {
        const compressResult = await compressRawLtForDate(env, yesterdayStr);
        console.log("📦 Compression result:", JSON.stringify(compressResult));
      } catch (err) {
        console.error("❌ Compression failed:", err);
      }

      // Delete old raw_lt (7 days retention)
      try {
        const deleteResult = await deleteOldRawLt(env, 7);
        console.log("🗑️ Deletion result:", JSON.stringify(deleteResult));
      } catch (err) {
        console.error("❌ Deletion failed:", err);
      }
    } else {
      // Sesi 1 selesai / break / sesi 2 masih jalan → jangan final
      state.done = false;
      console.log(
        "⏸ stepBackfill DONE tapi market belum closed → akan lanjut kalau ada file baru (sesi berikutnya)."
      );
    }

    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else if (data.status === "EMPTY") {
    console.log(`⚠️ Tidak ada data untuk tanggal ${dateStr} (status EMPTY).`);
    state.cursor = null;

    if (marketClosed) {
      // Misal hari libur penuh → boleh dianggap done
      state.done = true;
      console.log("📄 Hari ini kosong & market closed → tandai done.");
    } else {
      // Pagi sebelum market buka → jangan di-mark done, biar cron cek lagi nanti
      state.done = false;
      console.log(
        "🌅 EMPTY tapi market belum closed → akan cek lagi nanti (mungkin market belum buka)."
      );
    }

    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else {
    console.error("❌ Unknown status dari stepBackfill:", data);
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
    const hakaNorm = (hakaRatio - 0.5) * 2; // 0.5 → 0, 1 → +1, 0 → -1
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

      // Absorption: cumVol / (high - low). Jika range 0 → fallback ke cumVol
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
        dv: bucketVal, // value per bucket → bubble size
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

      // ➕ raw trade terakhir (kalau mau dipakai di UI)
      last_raw: s.lastRaw || null,
    };
  });
}

/**
 * LOGIC UTAMA BACKFILL
 */
async function stepBackfill(env, url) {
  const dateParam = url.searchParams.get("date");
  const cursor = url.searchParams.get("cursor");
  const reset = url.searchParams.get("reset");
  const noSnapshot = url.searchParams.get("noSnapshot") === "1"; // ⬅️ FLAG BARU

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
          // Regex gagal → catat & coba fallback
          regexFailCount++;
          if (regexFailCount <= MAX_LOG_SAMPLE) {
            console.warn("⚠️ Regex RAW gagal parse line (sample):", line.slice(0, 200));
          }

          // --- 2) Fallback: coba format lama (JSON.parse) ---
          try {
            const objLegacy = JSON.parse(line);
            if (objLegacy && typeof objLegacy.raw === "string") {
              legacyParseCount++;
              raw = objLegacy.raw;

              if (legacyParseCount <= MAX_LOG_SAMPLE) {
                console.warn("ℹ️ Line parsed via legacy JSON.parse (raw_lt lama).");
              }
            } else {
              // format lama pun aneh → buang baris ini
              return;
            }
          } catch (eLegacy) {
            // regex + JSON.parse dua-duanya gagal → skip baris busuk
            if (regexFailCount <= MAX_LOG_SAMPLE) {
              console.warn("❌ Regex & JSON.parse gagal parse line (raw_lt):", line.slice(0, 200));
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
                  console.warn("⚠️ DIFF raw_lt: regex vs legacy berbeda.", {
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
    });
  });

  // Setelah semua file diproses, log summary parsing
  if (regexFailCount > 0 || legacyParseCount > 0 || diffCount > 0) {
    console.warn(
      `📊 stepBackfill parse summary: regexFail=${regexFailCount}, legacyParse=${legacyParseCount}, diffRaw=${diffCount}`
    );
  }


  const hasMore = listed.truncated;
  const nextCursor = listed.cursor;
  // ⚠️ MODE RINGAN: kalau noSnapshot = true, JANGAN build finalOutput sama sekali
  if (noSnapshot) {
    await env.DATA_LAKE.put(tempFile, JSON.stringify(stats));

    const status = hasMore ? "PROGRESS" : "DONE";

    return new Response(
      JSON.stringify(
        {
          status,
          processed: listed.objects.length,
          next_cursor: hasMore ? nextCursor : null,
          limit_used: limit,
          note: "noSnapshot mode, hanya update temp_state",
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
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

  // Batch terakhir → FINAL EOD
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

  console.log(`🗜️ Starting compression for ${dateStr}...`);

  // Check if already compressed
  const existing = await env.DATA_LAKE.head(outputKey);
  if (existing) {
    console.log(`✅ Already compressed: ${outputKey}`);
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
      console.log(`⚠️ Reached limit: ${files.length} files listed in ${listCount} calls`);
      break;
    }
  } while (cursor);

  if (files.length === 0) {
    console.log(`⚠️ No files to compress for ${dateStr}`);
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

  console.log(`✅ Compressed ${dateStr}: ${files.length} files, ${originalSize}→${compressedSize} bytes (${compressionRatio}%)`);

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

  console.log(`🗑️ Deleting raw_lt older than ${cutoffStr} (${retentionDays} days retention)`);

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
    console.log(`✅ No old files to delete (found dates: ${Array.from(datesFound).sort()})`);
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

  console.log(`✅ Deleted ${deleted} old raw_lt files (cutoff: ${cutoffStr})`);

  return {
    deleted: true,
    fileCount: deleted,
    cutoffDate: cutoffStr,
    datesDeleted: Array.from(datesFound).filter(d => d < cutoffStr).sort()
  };
}

