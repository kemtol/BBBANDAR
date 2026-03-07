/**
 * yfinance-handler — Cloudflare Worker (Queue-based)
 *
 * Arsitektur:
 *   Producer (HTTP / Cron) → enqueue messages ke YFINANCE_QUEUE
 *   Consumer (queue handler) → fetch Yahoo Finance → simpan D1 + R2 + compute indicators
 *
 * D1 Tables (PRIMARY):
 *   yfinance_1d  (ticker, date, OHLCV, ma5, ma10, ma20, rsi14, rvol_2d/5d/10d/20d, vwap)
 *   yfinance_15m (ticker, date, time, OHLCV)
 *
 * R2 path (legacy backward compat, tetap ditulis):
 *   yfinance/{CODE}/1d/{YYYY-MM}.json
 *   yfinance/{CODE}/15m/{YYYY-MM-DD}.json
 *
 * Computed indicators (per ticker, at write time):
 *   MA5, MA10, MA20  — simple moving averages of close
 *   RSI14            — Wilder's relative strength index (14-period)
 *   RVOL_2D/5D/10D/20D — relative volume (today_vol / avg_vol)
 *   VWAP             — volume-weighted average price from 15m candles
 *
 * HTTP routes:
 *   POST /sync                → enqueue sync hari ini
 *   POST /sync?symbol=BBRI    → enqueue sync satu symbol
 *   POST /backfill            → enqueue backfill semua emiten
 *   GET  /status              → last sync info
 *   GET  /read?symbol=BBRI&interval=1d&date=2026-03-04
 *   GET  /list?symbol=BBRI&interval=1d
 *   GET  /indicators?symbol=BBRI&date=2026-03-06
 *   GET  /indicators?date=2026-03-06  (all tickers, untuk features-service)
 *
 * Cron: 30 9 * * 1-5 (16:30 WIB) → enqueue sync semua emiten
 */

// ─── Constants ───────────────────────────────────────────────────────────
const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const INTERVALS = ["1d", "15m"];
const RANGE_MAP = { "1d": "6mo", "15m": "60d" };
const SEND_BATCH_CHUNK = 50;
const D1_BATCH = 50; // Cloudflare D1 batch limit per call

// ─── Helpers ─────────────────────────────────────────────────────────────

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bareCode(ticker) {
  return ticker.replace(/\.JK$/i, "").toUpperCase();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

// ─── Yahoo Finance Fetch ─────────────────────────────────────────────────

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
  if (!result) { console.warn(`[YF] ${yfSymbol} no chart result`); return null; }

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const rows = [];

  for (let i = 0; i < timestamps.length; i++) {
    if (q.open?.[i] == null && q.close?.[i] == null) continue;
    const d = new Date(timestamps[i] * 1000);
    rows.push({
      datetime: d.toISOString(),
      date: fmtDate(d),
      time: d.toISOString().slice(11, 16),
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close: q.close?.[i] ?? null,
      volume: q.volume?.[i] ?? 0,
    });
  }
  return rows;
}

// ─── D1 Storage ──────────────────────────────────────────────────────────

/**
 * Store 1d candles ke D1 yfinance_1d table (OHLCV saja, indicators di-compute terpisah).
 */
async function store1dToD1(env, ticker, rows) {
  if (!rows?.length) return 0;
  const now = new Date().toISOString();
  let written = 0;

  for (let i = 0; i < rows.length; i += D1_BATCH) {
    const chunk = rows.slice(i, i + D1_BATCH);
    const stmts = chunk.map(r =>
      env.SSSAHAM_DB.prepare(
        `INSERT OR REPLACE INTO yfinance_1d (ticker, date, open, high, low, close, volume, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(ticker, r.date, r.open, r.high, r.low, r.close, r.volume, now)
    );
    await env.SSSAHAM_DB.batch(stmts);
    written += chunk.length;
  }
  return written;
}

/**
 * Store 15m candles ke D1 yfinance_15m table.
 */
async function store15mToD1(env, ticker, rows) {
  if (!rows?.length) return 0;
  const now = new Date().toISOString();
  let written = 0;

  for (let i = 0; i < rows.length; i += D1_BATCH) {
    const chunk = rows.slice(i, i + D1_BATCH);
    const stmts = chunk.map(r =>
      env.SSSAHAM_DB.prepare(
        `INSERT OR REPLACE INTO yfinance_15m (ticker, date, time, open, high, low, close, volume, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(ticker, r.date, r.time, r.open, r.high, r.low, r.close, r.volume, now)
    );
    await env.SSSAHAM_DB.batch(stmts);
    written += chunk.length;
  }
  return written;
}

// ─── R2 Storage (legacy backward compat) ─────────────────────────────────

async function storeToR2(env, symbol, interval, rows) {
  if (!rows || rows.length === 0) return 0;
  const code = bareCode(symbol);

  if (interval === "1d") {
    // Monthly consolidation
    const byMonth = {};
    for (const row of rows) {
      const mk = monthKey(row.date);
      if (!byMonth[mk]) byMonth[mk] = [];
      byMonth[mk].push(row);
    }
    let count = 0;
    for (const [month, newCandles] of Object.entries(byMonth)) {
      const r2Key = `yfinance/${code}/1d/${month}.json`;
      let existing = [];
      try {
        const obj = await env.TAPE_DATA_SAHAM.get(r2Key);
        if (obj) existing = (JSON.parse(await obj.text()))?.candles || [];
      } catch {}
      const byDate = new Map();
      for (const c of existing) byDate.set(c.date, c);
      for (const c of newCandles) byDate.set(c.date, c);
      const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      await env.TAPE_DATA_SAHAM.put(r2Key, JSON.stringify({
        symbol: code, interval: "1d", month, count: merged.length,
        candles: merged, updated_at: new Date().toISOString(),
      }), { httpMetadata: { contentType: "application/json" } });
      count++;
    }
    return count;
  }

  // 15m: daily files
  const byDate = {};
  for (const row of rows) { if (!byDate[row.date]) byDate[row.date] = []; byDate[row.date].push(row); }
  let count = 0;
  for (const [date, candles] of Object.entries(byDate)) {
    const r2Key = `yfinance/${code}/${interval}/${date}.json`;
    await env.TAPE_DATA_SAHAM.put(r2Key, JSON.stringify({
      symbol: code, interval, date, count: candles.length,
      candles, updated_at: new Date().toISOString(),
    }), { httpMetadata: { contentType: "application/json" } });
    count++;
  }
  return count;
}

// ─── Indicator Computation ───────────────────────────────────────────────

/**
 * Compute RSI menggunakan Wilder's smoothing method.
 * @param {number[]} closes - array closing prices (chronological, oldest first)
 * @param {number} period - RSI period (default 14)
 * @returns {number|null}
 */
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder's smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

/**
 * Compute MA5, MA10, MA20, RSI14, RVOL, VWAP untuk satu ticker.
 * Dipanggil setelah insert data baru.
 * Fetch last 35 rows dari D1 (cukup untuk MA20 + RSI14 warmup).
 * Hanya UPDATE baris yang berubah (recent dates).
 */
async function computeIndicators(env, ticker, mode) {
  // 1. Ambil last 35 daily candles (MA20 butuh 20, RSI warmup 14+1)
  const { results: dailyRows } = await env.SSSAHAM_DB.prepare(
    `SELECT date, close, volume FROM yfinance_1d
     WHERE ticker = ? ORDER BY date DESC LIMIT 35`
  ).bind(ticker).all();

  if (!dailyRows || dailyRows.length === 0) return;

  // Reverse jadi chronological (oldest first)
  const candles = dailyRows.reverse();
  const closes = candles.map(r => Number(r.close));
  const volumes = candles.map(r => Number(r.volume));

  // 2. Compute indicators per row
  const updates = [];

  for (let i = 0; i < candles.length; i++) {
    const u = { date: candles[i].date };
    let hasUpdate = false;

    // MA5
    if (i >= 4) {
      u.ma5 = parseFloat((closes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5).toFixed(2));
      hasUpdate = true;
    }
    // MA10
    if (i >= 9) {
      u.ma10 = parseFloat((closes.slice(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10).toFixed(2));
      hasUpdate = true;
    }
    // MA20
    if (i >= 19) {
      u.ma20 = parseFloat((closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20).toFixed(2));
      hasUpdate = true;
    }

    // RSI14 — use all closes up to this point
    if (i >= 14) {
      const rsi = computeRSI(closes.slice(0, i + 1), 14);
      if (rsi != null) { u.rsi14 = rsi; hasUpdate = true; }
    }

    // RVOL (today_volume / avg_volume_of_previous_N_days)
    const todayVol = volumes[i];
    if (todayVol > 0) {
      for (const [n, key] of [[2, "rvol_2d"], [5, "rvol_5d"], [10, "rvol_10d"], [20, "rvol_20d"]]) {
        if (i >= n) {
          const prevVols = volumes.slice(Math.max(0, i - n), i).filter(v => v > 0);
          if (prevVols.length > 0) {
            const avg = prevVols.reduce((a, b) => a + b, 0) / prevVols.length;
            u[key] = parseFloat((todayVol / avg).toFixed(2));
            hasUpdate = true;
          }
        }
      }
    }

    if (hasUpdate) updates.push(u);
  }

  // 3. VWAP dari 15m candles — hanya untuk recent 5 dates (limit D1 reads)
  const dates = [...new Set(updates.map(u => u.date))];
  const recentDates = mode === "backfill" ? dates : dates.slice(-5);
  if (recentDates.length > 0) {
    const ph = recentDates.map(() => "?").join(",");
    const { results: intraRows } = await env.SSSAHAM_DB.prepare(
      `SELECT date, high, low, close, volume FROM yfinance_15m
       WHERE ticker = ? AND date IN (${ph}) ORDER BY date, time`
    ).bind(ticker, ...recentDates).all();

    const vwapByDate = new Map();
    const grouped = new Map();
    for (const r of (intraRows || [])) {
      if (!grouped.has(r.date)) grouped.set(r.date, []);
      grouped.get(r.date).push(r);
    }
    for (const [dt, rows] of grouped) {
      let sumTPxV = 0, sumV = 0;
      for (const r of rows) {
        const h = Number(r.high), l = Number(r.low), c = Number(r.close), v = Number(r.volume);
        if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || v <= 0) continue;
        sumTPxV += ((h + l + c) / 3) * v;
        sumV += v;
      }
      if (sumV > 0) vwapByDate.set(dt, parseFloat((sumTPxV / sumV).toFixed(2)));
    }

    for (const u of updates) {
      if (vwapByDate.has(u.date)) u.vwap = vwapByDate.get(u.date);
    }
  }

  // 4. Batch UPDATE yfinance_1d
  //    Untuk sync: hanya update recent rows (last 5)
  //    Untuk backfill: update semua rows yang punya indicator
  const toUpdate = mode === "backfill" ? updates : updates.slice(-5);
  const stmts = [];
  for (const u of toUpdate) {
    const sets = [];
    const vals = [];
    for (const [col, val] of Object.entries(u)) {
      if (col === "date") continue;
      if (val != null) { sets.push(`${col} = ?`); vals.push(val); }
    }
    if (sets.length === 0) continue;
    stmts.push(
      env.SSSAHAM_DB.prepare(
        `UPDATE yfinance_1d SET ${sets.join(", ")} WHERE ticker = ? AND date = ?`
      ).bind(...vals, ticker, u.date)
    );
  }

  if (stmts.length === 0) return;

  for (let i = 0; i < stmts.length; i += D1_BATCH) {
    await env.SSSAHAM_DB.batch(stmts.slice(i, i + D1_BATCH));
  }

  console.log(`[indicators] ${ticker}: updated ${stmts.length} rows (MA/RSI/RVOL/VWAP)`);
}

// ─── Process One Symbol ──────────────────────────────────────────────────

async function processSymbol(env, symbol, mode) {
  const results = {};
  let allOk = true;
  const code = bareCode(symbol);

  for (const interval of INTERVALS) {
    const range = mode === "backfill" ? RANGE_MAP[interval] : "5d";

    try {
      const rows = await fetchYahooChart(symbol, interval, range);
      if (!rows) {
        results[interval] = { ok: false, error: "no data from Yahoo" };
        allOk = false;
        continue;
      }

      // Primary: D1
      let d1Written = 0;
      if (interval === "1d") {
        d1Written = await store1dToD1(env, code, rows);
      } else {
        d1Written = await store15mToD1(env, code, rows);
      }

      // Legacy: R2 (backward compat)
      const r2Written = await storeToR2(env, symbol, interval, rows);

      results[interval] = { ok: true, candles: rows.length, d1: d1Written, r2: r2Written };
    } catch (err) {
      console.error(`[process] ${symbol} ${interval} error:`, err);
      results[interval] = { ok: false, error: err.message };
      allOk = false;
    }
  }

  // Compute indicators setelah semua interval tersimpan
  if (allOk || results["1d"]?.ok) {
    try {
      await computeIndicators(env, code, mode);
      results.indicators = { ok: true };
    } catch (err) {
      console.error(`[indicators] ${code} error:`, err);
      results.indicators = { ok: false, error: err.message };
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

async function enqueueSymbols(env, symbols, mode) {
  const messages = symbols.map((symbol) => ({ body: { symbol, mode, attempt: 0 } }));
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
  try { const obj = await env.TAPE_DATA_SAHAM.get(key); if (!obj) return null; return JSON.parse(await obj.text()); }
  catch { return null; }
}
async function putR2Json(env, key, data) {
  await env.TAPE_DATA_SAHAM.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

async function incrementQueueStats(env, { success = 0, failed = 0, symbol = "" }) {
  const stats = (await getR2Json(env, STATS_KEY)) || {
    run_id: null, enqueued_at: null, total_enqueued: 0,
    processed: 0, success: 0, failed: 0, last_processed: null, failed_symbols: [],
  };
  stats.processed += success + failed;
  stats.success += success;
  stats.failed += failed;
  stats.last_processed = new Date().toISOString();
  if (failed > 0 && symbol) {
    stats.failed_symbols.push(symbol);
    if (stats.failed_symbols.length > 50) stats.failed_symbols = stats.failed_symbols.slice(-50);
  }
  if (stats.processed >= stats.total_enqueued && stats.total_enqueued > 0) stats.finished_at = new Date().toISOString();
  await putR2Json(env, STATS_KEY, stats);
}

async function startNewRun(env, { mode, totalEnqueued }) {
  const stats = {
    run_id: crypto.randomUUID(), mode,
    enqueued_at: new Date().toISOString(), total_enqueued: totalEnqueued,
    processed: 0, success: 0, failed: 0, last_processed: null, finished_at: null, failed_symbols: [],
  };
  await putR2Json(env, STATS_KEY, stats);
  return stats.run_id;
}

// ─── HTTP Router ─────────────────────────────────────────────────────────

async function handleRequest(req, env) {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

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
    const [lastSync, queueStats] = await Promise.all([getR2Json(env, STATUS_KEY), getR2Json(env, STATS_KEY)]);
    return json({ ok: true, last_sync: lastSync, queue: queueStats });
  }

  // ── GET /indicators?symbol=BBRI&date=2026-03-06 (one ticker, history) ──
  // ── GET /indicators?date=2026-03-06 (all tickers for that date — features-service) ──
  if (url.pathname === "/indicators" && method === "GET") {
    const symbol = url.searchParams.get("symbol");
    const date = url.searchParams.get("date");
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);

    if (symbol) {
      const code = bareCode(symbol);
      if (date) {
        // Single ticker + date
        const row = await env.SSSAHAM_DB.prepare(
          `SELECT * FROM yfinance_1d WHERE ticker = ? AND date = ?`
        ).bind(code, date).first();
        return json({ ticker: code, date, row: row || null });
      }
      // Single ticker, recent history
      const { results } = await env.SSSAHAM_DB.prepare(
        `SELECT * FROM yfinance_1d WHERE ticker = ? ORDER BY date DESC LIMIT ?`
      ).bind(code, limit).all();
      return json({ ticker: code, count: results?.length || 0, rows: results || [] });
    }

    // All tickers for a specific date (bulk query for features-service)
    if (!date) return json({ error: "date or symbol required" }, 400);
    const { results } = await env.SSSAHAM_DB.prepare(
      `SELECT ticker, date, close, volume, ma5, ma10, ma20, rsi14,
              rvol_2d, rvol_5d, rvol_10d, rvol_20d, vwap
       FROM yfinance_1d WHERE date = ?`
    ).bind(date).all();
    return json({ date, count: results?.length || 0, rows: results || [] });
  }

  // ── GET /read?symbol=BBRI&interval=1d&date=2026-03-04 ──
  // ── GET /read?symbol=BBRI&interval=1d&month=2026-03 ──
  if (url.pathname === "/read" && method === "GET") {
    const symbol = url.searchParams.get("symbol");
    const interval = url.searchParams.get("interval") || "1d";
    const monthParam = url.searchParams.get("month");
    const date = url.searchParams.get("date") || (monthParam ? null : fmtDate(new Date()));
    if (!symbol) return json({ error: "symbol required" }, 400);
    const code = bareCode(symbol);

    if (interval === "1d") {
      const mk = monthParam || (date ? date.slice(0, 7) : fmtDate(new Date()).slice(0, 7));
      const { results } = await env.SSSAHAM_DB.prepare(
        `SELECT * FROM yfinance_1d WHERE ticker = ? AND date LIKE ? ORDER BY date ASC`
      ).bind(code, `${mk}%`).all();

      if (date && !monthParam) {
        // Filter to specific date
        const filtered = results?.filter(r => r.date === date) || [];
        if (filtered.length === 0) return json({ error: "date not found", symbol: code, date }, 404);
        return json({ symbol: code, interval, date, count: filtered.length, candles: filtered });
      }
      return json({ symbol: code, interval, month: mk, count: results?.length || 0, candles: results || [] });
    }

    // 15m
    const dt = date || fmtDate(new Date());
    const { results } = await env.SSSAHAM_DB.prepare(
      `SELECT * FROM yfinance_15m WHERE ticker = ? AND date = ? ORDER BY time ASC`
    ).bind(code, dt).all();
    return json({ symbol: code, interval, date: dt, count: results?.length || 0, candles: results || [] });
  }

  // ── GET /list?symbol=BBRI&interval=1d ──
  if (url.pathname === "/list" && method === "GET") {
    const symbol = url.searchParams.get("symbol");
    const interval = url.searchParams.get("interval") || "1d";
    if (!symbol) return json({ error: "symbol required" }, 400);
    const code = bareCode(symbol);

    if (interval === "1d") {
      const { results } = await env.SSSAHAM_DB.prepare(
        `SELECT DISTINCT substr(date,1,7) as month FROM yfinance_1d WHERE ticker = ? ORDER BY month DESC`
      ).bind(code).all();
      return json({ symbol: code, interval, months: results?.map(r => r.month) || [], count: results?.length || 0 });
    }

    const { results } = await env.SSSAHAM_DB.prepare(
      `SELECT DISTINCT date FROM yfinance_15m WHERE ticker = ? ORDER BY date DESC LIMIT 60`
    ).bind(code).all();
    return json({ symbol: code, interval, dates: results?.map(r => r.date) || [], count: results?.length || 0 });
  }

  // ── POST /sync ──
  if (url.pathname === "/sync" && method === "POST") {
    const symbolParam = url.searchParams.get("symbol");
    let symbols = symbolParam
      ? symbolParam.split(",").map(s => bareCode(s.trim()))
      : await getActiveEmitens(env);
    if (symbols.length === 0) return json({ error: "no active emitens found" }, 500);

    const runId = await startNewRun(env, { mode: "sync", totalEnqueued: symbols.length });
    const enqueued = await enqueueSymbols(env, symbols, "sync");
    return json({ ok: true, mode: "sync", run_id: runId, enqueued, message: `${enqueued} symbols enqueued` }, 202);
  }

  // ── POST /backfill ──
  if (url.pathname === "/backfill" && method === "POST") {
    const symbolParam = url.searchParams.get("symbol");
    let symbols = symbolParam
      ? symbolParam.split(",").map(s => bareCode(s.trim()))
      : await getActiveEmitens(env);
    if (symbols.length === 0) return json({ error: "no active emitens found" }, 500);

    const runId = await startNewRun(env, { mode: "backfill", totalEnqueued: symbols.length });
    const enqueued = await enqueueSymbols(env, symbols, "backfill");
    return json({ ok: true, mode: "backfill", run_id: runId, enqueued, message: `${enqueued} symbols enqueued for backfill` }, 202);
  }

  return json({ error: "not found", routes: ["/status", "/read", "/list", "/indicators", "/sync", "/backfill"] }, 404);
}

// ─── Cron Handler ────────────────────────────────────────────────────────

async function handleScheduled(event, env, ctx) {
  console.log(`[cron] yfinance sync triggered at ${new Date().toISOString()}`);
  const symbols = await getActiveEmitens(env);
  if (symbols.length === 0) { console.warn("[cron] no active emitens, skipping"); return; }

  const runId = await startNewRun(env, { mode: "cron-sync", totalEnqueued: symbols.length });
  const enqueued = await enqueueSymbols(env, symbols, "sync");

  await putR2Json(env, STATUS_KEY, {
    mode: "cron-sync", run_id: runId,
    triggered_at: new Date().toISOString(), total_enqueued: enqueued,
  });
  console.log(`[cron] enqueued ${enqueued} symbols (run_id: ${runId})`);
}

// ─── Queue Consumer ──────────────────────────────────────────────────────

async function handleQueue(batch, env) {
  const maxRetry = parseInt(env.MAX_RETRY || "2", 10);

  for (const msg of batch.messages) {
    const { symbol, mode, attempt = 0 } = msg.body;
    if (!symbol) { msg.ack(); continue; }

    try {
      console.log(`[queue] processing ${symbol} (mode=${mode}, attempt=${attempt})`);
      const { ok, results } = await processSymbol(env, symbol, mode);

      if (ok) {
        await incrementQueueStats(env, { success: 1, symbol });
        console.log(`[queue] ✅ ${symbol} done`, JSON.stringify(results));
        msg.ack();
      } else {
        if (attempt >= maxRetry) {
          console.error(`[queue] ❌ ${symbol} max retries (${maxRetry}) reached`, JSON.stringify(results));
          await incrementQueueStats(env, { failed: 1, symbol });
          msg.ack();
        } else {
          console.warn(`[queue] ⚠️ ${symbol} partial fail, re-enqueuing (${attempt + 1}/${maxRetry})`);
          await env.YFINANCE_QUEUE.send({ symbol, mode, attempt: attempt + 1 });
          msg.ack();
        }
      }
    } catch (err) {
      console.error(`[queue] 💥 ${symbol} unexpected error:`, err);
      if (attempt >= maxRetry) {
        await incrementQueueStats(env, { failed: 1, symbol });
        msg.ack();
      } else {
        await env.YFINANCE_QUEUE.send({ symbol, mode, attempt: attempt + 1 });
        msg.ack();
      }
    }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    try { return await handleRequest(req, env); }
    catch (err) { console.error("[fetch] unhandled error:", err); return json({ error: err.message }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(handleScheduled(event, env, ctx)); },
  async queue(batch, env) { await handleQueue(batch, env); },
};
