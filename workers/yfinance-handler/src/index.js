/**
 * yfinance-handler — Cloudflare Worker (Queue-based)
 *
 * Arsitektur:
 *   Producer (HTTP / Cron) → enqueue messages ke YFINANCE_QUEUE
 *   Consumer (queue handler) → fetch Yahoo Finance → simpan R2
 *
 * R2 path:
 *   yfinance/{CODE}/1d/{YYYY-MM-DD}.json   → daily OHLCV
 *   yfinance/{CODE}/15m/{YYYY-MM-DD}.json  → intraday 15-min OHLCV
 *
 * Queue message format:
 *   { symbol: "BBRI", mode: "sync"|"backfill", attempt: 0 }
 *
 * HTTP routes:
 *   POST /sync                → enqueue sync hari ini untuk semua emiten aktif
 *   POST /sync?symbol=BBRI    → enqueue sync satu symbol
 *   POST /backfill            → enqueue backfill semua emiten aktif
 *   POST /backfill?symbol=BBRI,TLKM
 *   GET  /status              → last sync info + queue stats
 *   GET  /read?symbol=BBRI&interval=1d&date=2026-03-04
 *   GET  /list?symbol=BBRI&interval=1d
 *
 * Cron: 0 11 * * 1-5 (18:00 WIB) → enqueue sync semua emiten
 */

// ─── Constants ───────────────────────────────────────────────────────────
const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const INTERVALS = ["1d", "15m"];

// Yahoo Finance limits: 15m data hanya tersedia ~60 hari ke belakang
const RANGE_MAP = {
  "1d": "6mo",
  "15m": "60d",
};

const SEND_BATCH_CHUNK = 50; // Cloudflare Queues max per sendBatch

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Format Date → "YYYY-MM-DD" */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Strip ".JK" dari ticker */
function bareCode(ticker) {
  return ticker.replace(/\.JK$/i, "").toUpperCase();
}

/** JSON response helper */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Yahoo Finance Fetch ─────────────────────────────────────────────────

/**
 * Fetch OHLCV chart data dari Yahoo Finance.
 * @param {string} symbol – e.g. "BBRI"
 * @param {string} interval – "1d" | "15m"
 * @param {string} range – "6mo" | "60d" | "5d"
 * @returns {Array<{date,open,high,low,close,volume}>} atau null
 */
async function fetchYahooChart(symbol, interval, range) {
  const yfSymbol = `${symbol}.JK`;
  const url = `${YF_BASE}/${encodeURIComponent(yfSymbol)}?interval=${interval}&range=${range}&includePrePost=false`;

  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`[YF] ${yfSymbol} ${interval} ${range} → ${resp.status}: ${txt.slice(0, 200)}`);
    return null;
  }

  const body = await resp.json();
  const result = body?.chart?.result?.[0];
  if (!result) {
    console.warn(`[YF] ${yfSymbol} no chart result`);
    return null;
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (opens[i] == null && closes[i] == null) continue;

    const ts = timestamps[i] * 1000;
    const d = new Date(ts);

    rows.push({
      datetime: d.toISOString(),
      date: fmtDate(d),
      time: d.toISOString().slice(11, 16),
      open: opens[i] ?? null,
      high: highs[i] ?? null,
      low: lows[i] ?? null,
      close: closes[i] ?? null,
      volume: volumes[i] ?? 0,
    });
  }

  return rows;
}

// ─── R2 Storage ──────────────────────────────────────────────────────────

/**
 * Group rows berdasarkan tanggal, lalu simpan ke R2.
 * Path: yfinance/{CODE}/{interval}/{YYYY-MM-DD}.json
 */
async function storeToR2(env, symbol, interval, rows) {
  if (!rows || rows.length === 0) return 0;

  const byDate = {};
  for (const row of rows) {
    const key = row.date;
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(row);
  }

  const code = bareCode(symbol);
  let count = 0;

  for (const [date, candles] of Object.entries(byDate)) {
    const r2Key = `yfinance/${code}/${interval}/${date}.json`;

    const payload = {
      symbol: code,
      interval,
      date,
      count: candles.length,
      candles,
      updated_at: new Date().toISOString(),
    };

    await env.TAPE_DATA_SAHAM.put(r2Key, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    });
    count++;
  }

  return count;
}

// ─── Process One Symbol (dipakai oleh queue consumer) ────────────────────

/**
 * Fetch + store satu symbol untuk semua interval.
 * @returns {{ ok: boolean, results: object }}
 */
async function processSymbol(env, symbol, mode) {
  const results = {};
  let allOk = true;

  for (const interval of INTERVALS) {
    const range = mode === "backfill" ? RANGE_MAP[interval] : "5d";

    try {
      const rows = await fetchYahooChart(symbol, interval, range);
      if (!rows) {
        results[interval] = { ok: false, error: "no data from Yahoo" };
        allOk = false;
        continue;
      }

      const filesWritten = await storeToR2(env, symbol, interval, rows);
      results[interval] = { ok: true, candles: rows.length, files: filesWritten };
    } catch (err) {
      console.error(`[process] ${symbol} ${interval} error:`, err);
      results[interval] = { ok: false, error: err.message };
      allOk = false;
    }
  }

  return { ok: allOk, results };
}

// ─── Emiten List ─────────────────────────────────────────────────────────

async function getActiveEmitens(env) {
  try {
    const { results } = await env.SSSAHAM_DB.prepare(
      "SELECT ticker FROM emiten WHERE status = 'ACTIVE' ORDER BY ticker ASC"
    ).all();
    return results.map((r) => bareCode(r.ticker)).filter((s) => s && s.length >= 4);
  } catch (err) {
    console.error("[D1] failed to get emiten list:", err);
    return [];
  }
}

// ─── Queue Producer ──────────────────────────────────────────────────────

/**
 * Enqueue symbols ke YFINANCE_QUEUE.
 * 1 message = 1 symbol.
 * Kirim dalam chunk 50 (batas Cloudflare sendBatch).
 */
async function enqueueSymbols(env, symbols, mode) {
  const messages = symbols.map((symbol) => ({
    body: { symbol, mode, attempt: 0 },
  }));

  let enqueued = 0;
  for (let i = 0; i < messages.length; i += SEND_BATCH_CHUNK) {
    const chunk = messages.slice(i, i + SEND_BATCH_CHUNK);
    await env.YFINANCE_QUEUE.sendBatch(chunk);
    enqueued += chunk.length;
  }

  return enqueued;
}

// ─── Sync Status Tracking ────────────────────────────────────────────────

const STATUS_KEY = "yfinance/_meta/last_sync.json";
const STATS_KEY = "yfinance/_meta/queue_stats.json";

async function getR2Json(env, key) {
  try {
    const obj = await env.TAPE_DATA_SAHAM.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

async function putR2Json(env, key, data) {
  await env.TAPE_DATA_SAHAM.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Increment queue stats (success/failed counters).
 */
async function incrementQueueStats(env, { success = 0, failed = 0, symbol = "" }) {
  const stats = (await getR2Json(env, STATS_KEY)) || {
    run_id: null,
    enqueued_at: null,
    total_enqueued: 0,
    processed: 0,
    success: 0,
    failed: 0,
    last_processed: null,
    failed_symbols: [],
  };

  stats.processed += success + failed;
  stats.success += success;
  stats.failed += failed;
  stats.last_processed = new Date().toISOString();

  if (failed > 0 && symbol) {
    stats.failed_symbols.push(symbol);
    if (stats.failed_symbols.length > 50) {
      stats.failed_symbols = stats.failed_symbols.slice(-50);
    }
  }

  if (stats.processed >= stats.total_enqueued && stats.total_enqueued > 0) {
    stats.finished_at = new Date().toISOString();
  }

  await putR2Json(env, STATS_KEY, stats);
}

/**
 * Start new run — reset queue stats.
 */
async function startNewRun(env, { mode, totalEnqueued }) {
  const stats = {
    run_id: crypto.randomUUID(),
    mode,
    enqueued_at: new Date().toISOString(),
    total_enqueued: totalEnqueued,
    processed: 0,
    success: 0,
    failed: 0,
    last_processed: null,
    finished_at: null,
    failed_symbols: [],
  };
  await putR2Json(env, STATS_KEY, stats);
  return stats.run_id;
}

// ─── HTTP Router (Producer) ──────────────────────────────────────────────

async function handleRequest(req, env) {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // ── GET /status ──
  if (url.pathname === "/status" && method === "GET") {
    const [lastSync, queueStats] = await Promise.all([
      getR2Json(env, STATUS_KEY),
      getR2Json(env, STATS_KEY),
    ]);
    return json({ ok: true, last_sync: lastSync, queue: queueStats });
  }

  // ── GET /read?symbol=BBRI&interval=1d&date=2026-03-04 ──
  if (url.pathname === "/read" && method === "GET") {
    const symbol = url.searchParams.get("symbol");
    const interval = url.searchParams.get("interval") || "1d";
    const date = url.searchParams.get("date") || fmtDate(new Date());

    if (!symbol) return json({ error: "symbol required" }, 400);

    const code = bareCode(symbol);
    const r2Key = `yfinance/${code}/${interval}/${date}.json`;
    const obj = await env.TAPE_DATA_SAHAM.get(r2Key);

    if (!obj) return json({ error: "not found", key: r2Key }, 404);

    return new Response(await obj.text(), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // ── GET /list?symbol=BBRI&interval=1d ──
  if (url.pathname === "/list" && method === "GET") {
    const symbol = url.searchParams.get("symbol");
    const interval = url.searchParams.get("interval") || "1d";

    if (!symbol) return json({ error: "symbol required" }, 400);

    const code = bareCode(symbol);
    const prefix = `yfinance/${code}/${interval}/`;
    const listed = await env.TAPE_DATA_SAHAM.list({ prefix, limit: 1000 });

    const dates = listed.objects.map((o) =>
      o.key.replace(prefix, "").replace(".json", "")
    );

    return json({ symbol: code, interval, dates, count: dates.length });
  }

  // ── POST /sync ──  (enqueue, return 202 immediately)
  if (url.pathname === "/sync" && method === "POST") {
    const symbolParam = url.searchParams.get("symbol");

    let symbols;
    if (symbolParam) {
      symbols = symbolParam.split(",").map((s) => bareCode(s.trim()));
    } else {
      symbols = await getActiveEmitens(env);
      if (symbols.length === 0) return json({ error: "no active emitens found" }, 500);
    }

    const runId = await startNewRun(env, { mode: "sync", totalEnqueued: symbols.length });
    const enqueued = await enqueueSymbols(env, symbols, "sync");

    return json(
      {
        ok: true,
        mode: "sync",
        run_id: runId,
        enqueued,
        message: `${enqueued} symbols enqueued for sync. Track progress at GET /status`,
      },
      202
    );
  }

  // ── POST /backfill ──  (enqueue, return 202 immediately)
  if (url.pathname === "/backfill" && method === "POST") {
    const symbolParam = url.searchParams.get("symbol");

    let symbols;
    if (symbolParam) {
      symbols = symbolParam.split(",").map((s) => bareCode(s.trim()));
    } else {
      symbols = await getActiveEmitens(env);
      if (symbols.length === 0) return json({ error: "no active emitens found" }, 500);
    }

    const runId = await startNewRun(env, { mode: "backfill", totalEnqueued: symbols.length });
    const enqueued = await enqueueSymbols(env, symbols, "backfill");

    return json(
      {
        ok: true,
        mode: "backfill",
        run_id: runId,
        enqueued,
        message: `${enqueued} symbols enqueued for backfill. Track progress at GET /status`,
      },
      202
    );
  }

  return json(
    { error: "not found", routes: ["/status", "/read", "/list", "/sync", "/backfill"] },
    404
  );
}

// ─── Cron Handler (Producer) ─────────────────────────────────────────────

async function handleScheduled(event, env, ctx) {
  console.log(`[cron] yfinance sync triggered at ${new Date().toISOString()}`);

  const symbols = await getActiveEmitens(env);
  if (symbols.length === 0) {
    console.warn("[cron] no active emitens, skipping");
    return;
  }

  const runId = await startNewRun(env, { mode: "cron-sync", totalEnqueued: symbols.length });
  const enqueued = await enqueueSymbols(env, symbols, "sync");

  await putR2Json(env, STATUS_KEY, {
    mode: "cron-sync",
    run_id: runId,
    triggered_at: new Date().toISOString(),
    total_enqueued: enqueued,
  });

  console.log(`[cron] enqueued ${enqueued} symbols (run_id: ${runId})`);
}

// ─── Queue Consumer ──────────────────────────────────────────────────────

async function handleQueue(batch, env) {
  const maxRetry = parseInt(env.MAX_RETRY || "2", 10);

  for (const msg of batch.messages) {
    const { symbol, mode, attempt = 0 } = msg.body;

    if (!symbol) {
      console.warn("[queue] skipping message without symbol");
      msg.ack();
      continue;
    }

    try {
      console.log(`[queue] processing ${symbol} (mode=${mode}, attempt=${attempt})`);

      const { ok, results } = await processSymbol(env, symbol, mode);

      if (ok) {
        await incrementQueueStats(env, { success: 1, symbol });
        console.log(`[queue] ✅ ${symbol} done`, JSON.stringify(results));
        msg.ack();
      } else {
        // Partial failure — some intervals failed
        if (attempt >= maxRetry) {
          console.error(
            `[queue] ❌ ${symbol} max retries (${maxRetry}) reached, giving up.`,
            JSON.stringify(results)
          );
          await incrementQueueStats(env, { failed: 1, symbol });
          msg.ack();
        } else {
          console.warn(
            `[queue] ⚠️ ${symbol} partial fail, re-enqueuing (${attempt + 1}/${maxRetry})`
          );
          await env.YFINANCE_QUEUE.send({
            symbol,
            mode,
            attempt: attempt + 1,
          });
          msg.ack(); // ack original, new message enqueued
        }
      }
    } catch (err) {
      console.error(`[queue] 💥 ${symbol} unexpected error:`, err);

      if (attempt >= maxRetry) {
        console.error(`[queue] ❌ ${symbol} max retries after error, giving up`);
        await incrementQueueStats(env, { failed: 1, symbol });
        msg.ack();
      } else {
        await env.YFINANCE_QUEUE.send({
          symbol,
          mode,
          attempt: attempt + 1,
        });
        msg.ack();
      }
    }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    try {
      return await handleRequest(req, env);
    } catch (err) {
      console.error("[fetch] unhandled error:", err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env, ctx));
  },

  async queue(batch, env) {
    await handleQueue(batch, env);
  },
};
