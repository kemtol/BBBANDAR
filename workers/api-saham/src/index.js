/**
 * ============================================================
 * api-saham (Cloudflare Worker) — Endpoint Documentation (v2026-02-04)
 * ============================================================
 *
 * Purpose
 * - Public API for screener, broker summary range, footprint/ orderflow, AI screenshot+analysis.
 * - Mostly READS data from R2/D1, and WRITES only derived caches (SSSAHAM_EMITEN) + AI artifacts.
 * - Can TRIGGER upstream repair/backfill services (does not write raw taping files directly).
 *
 * Global behavior
 * - CORS enabled for all responses via withCORS()
 * - OPTIONS preflight returns 204
 *
 * Storage / bindings (high-level)
 * - env.SSSAHAM_EMITEN (R2): features cache, logo cache, AI screenshots & AI analysis cache, cache-summary results
 * - env.RAW_BROKSUM (R2): raw broker-summary daily files and per-ticker broksum caches
 * - env.FOOTPRINT_BUCKET (R2): raw footprint 1m jsonl segments and processed daily footprint files
 * - env.SSSAHAM_DB (D1): brokers table, temp_footprint_consolidate, daily_features, scraping_logs
 * - env.BROKSUM_SERVICE (Service Binding): triggers broker summary backfill
 * - external: livetrade-taping-agregator repair-footprint trigger
 * - env.AI_SCREENSHOT_SERVICE / *_URL: screenshot capture service trigger
 *
 * ------------------------------------------------------------
 * PUBLIC ENDPOINTS
 * ------------------------------------------------------------
 *
 * GET /health
 * - Health check
 * - Returns: { ok: true, service: "api-saham" }
 *
 * GET /screener
 * - Returns latest Z-score screener (via pointer features/latest.json)
 * - Reads: SSSAHAM_EMITEN
 *
 * GET /screener-accum[?window=2|5|10|20]
 * - Returns accumulation scanner data (prebuilt) merged with screener z-score fields
 * - Reads: SSSAHAM_EMITEN (cache/screener-accum-latest.json, features/latest.json -> pointer)
 *
 * GET /features/history?symbol=BBRI
 * - Returns per-ticker z-score audit trail JSON
 * - Reads: SSSAHAM_EMITEN features/z_score/emiten/{ticker}.json
 *
 * GET /features/calculate?symbol=BBRI
 * - On-demand feature calc (z-ish) using broksum cache first, then D1 footprint fallback
 * - Reads: RAW_BROKSUM broksum/{ticker}/cache.json, D1 temp_footprint_consolidate
 *
 * GET /brokers
 * - Returns brokers table as ARRAY
 * - Reads: D1 brokers
 *
 * GET /cache-summary?symbol=BBRI&from=YYYY-MM-DD&to=YYYY-MM-DD[&cache=default|rebuild|off][&reload=true][&include_orderflow=false]
 * - Range broker summary aggregation + top brokers + aggregated foreign/retail/local
 * - Cache read/write (R2): broker/summary/v4/{symbol}/{from}_{to}.json
 * - If include_orderflow (default true): attaches /orderflow snapshot (D1 temp_footprint_consolidate + daily_features)
 * - TRIGGERS (indirect): if data empty/incomplete -> env.BROKSUM_SERVICE auto-backfill (fire-and-forget)
 * - Writes (derived): SSSAHAM_EMITEN cache
 *
 * GET /foreign-flow-scanner
 * - Returns pre-computed foreign flow trend
 * - Reads: SSSAHAM_EMITEN features/foreign-flow-scanner.json
 *
 * GET /foreign-sentiment?days=7
 * - Gross foreign buy/sell/net for MVP tickers + cumulative
 * - Cache R2: cache/foreign-sentiment-{days}d-v1.json (TTL ~1h)
 * - Reads: RAW_BROKSUM {ticker}/{date}.json, brokers mapping from D1 (retail classification)
 * - Writes: SSSAHAM_EMITEN cache
 *
 * GET /footprint/summary
 * - Returns footprint hybrid summary from features/footprint-summary.json
 * - Weekend / empty / zscore-only fallback: calculates last FULL day via calculateFootprintRange() scanning up to 7 days back
 * - Reads: SSSAHAM_EMITEN features/footprint-summary.json, D1 temp_footprint_consolidate (+ daily_features as context)
 *
 * GET /footprint/range?from=YYYY-MM-DD&to=YYYY-MM-DD
 * - Calculates footprint hybrid over a date range using D1 temp_footprint_consolidate + daily_features context
 * - Reads: D1
 *
 * GET /footprint-raw-hist?kode=BBRI[&date=YYYY-MM-DD]
 * - Returns minute-level chart components: { buckets, tableData, candles, is_repairing, is_fallback }
 * - Reads raw 1m segments (00-23 UTC): FOOTPRINT_BUCKET footprint/{kode}/1m/YYYY/MM/DD/HH.jsonl
 * - Fallback sources (if broken/empty/incomplete):
 *   P1: SSSAHAM_EMITEN processed/{kode}/intraday.json
 *   P2: FOOTPRINT_BUCKET processed/{dateStr}.json (pick ticker)
 * - TRIGGERS: if decision.repair && non-sparse -> POST livetrade-taping-agregator /repair-footprint (fire-and-forget)
 *
 * GET /symbol?kode=BBRI
 * - Returns snapshot + state + repair/fallback flags (chart detail lives in /footprint-raw-hist)
 * - Reads: D1 temp_footprint_consolidate + daily_features, FOOTPRINT_BUCKET raw segments (00-23 UTC)
 * - Same fallback strategy (P1/P2) + same repair trigger gating
 *
 * GET /audit/logs?limit=100
 * - Returns scraping logs (D1)
 * - Reads: D1 scraping_logs
 *
 * GET /audit-trail?symbol=BBRI&limit=100
 * - Returns audit entries for symbol from R2
 * - Reads: SSSAHAM_EMITEN audit/{symbol}.json
 *
 * GET /logo?ticker=BBRI
 * - Serves logo image from R2 cache or read-through from upstream assets.stockbit.com
 * - Reads/Writes: SSSAHAM_EMITEN logo/{ticker}.png
 *
 * GET /debug/raw-file?key=...
 * - Debug helper to inspect RAW_BROKSUM object body
 * - Reads: RAW_BROKSUM
 *
 * ------------------------------------------------------------
 * AI ENDPOINTS
 * ------------------------------------------------------------
 *
 * PUT /ai/screenshot?symbol=BBRI&label=7d[&origin=client|service]
 * - Uploads image/* to R2 with key: ai-screenshots/{symbol}/{today}_{label}.{ext}
 * - Writes: SSSAHAM_EMITEN ai-screenshots/...
 * - Side-effect: if origin !== "service" and label != "intraday", triggers intraday capture scheduling
 *
 * GET /ai/screenshot?key=ai-screenshots/...
 * - Serves stored screenshot image from R2
 *
 * POST /ai/analyze-broksum
 * Body: { symbol: "BBRI", image_keys: [{key,label}, ...], force?: true }
 * - Ensures "intraday" screenshot exists (may trigger capture and poll for availability)
 * - Calls OpenAI vision (gpt-4.1) to produce JSON analysis, retries once if JSON invalid
 * - Fallback chain: OpenAI → Grok (text-only) → Claude (vision) on failure/quota
 * - Caches result per range: ai-cache/{symbol}/{from}_{to}.json, TTL 24h (SSSAHAM_EMITEN)
 *
 * ------------------------------------------------------------
 * INTERNAL / OPS ENDPOINTS
 * ------------------------------------------------------------
 *
 * POST /internal/audit-backfill-daily?limit=40
 * - Triggers audit/backfill daily broker flow util
 * - Reads/Writes depend on auditAndBackfillDailyBrokerFlow implementation
 *
 * GET /integrity-scan
 * - Proxy to env.FEATURES_SERVICE.fetch(req)
 *
 * ------------------------------------------------------------
 * Side-effect summary (important!)
 * ------------------------------------------------------------
 * - This worker DOES NOT write raw taping streams directly (footprint jsonl / raw broksum daily json).
 * - It CAN trigger:
 *   - livetrade footprint repair/backfill via external /repair-footprint
 *   - broksum backfill via env.BROKSUM_SERVICE /auto-backfill
 * - It DOES write derived caches to SSSAHAM_EMITEN (cache-summary, logos, AI screenshots/analysis).
 */

// Import audit & backfill util
import { auditAndBackfillDailyBrokerFlow } from "./audit-backfill-daily.js";
import openapi from "./openapi.json";

const PUBLIC_PATHS = new Set(["/", "/docs", "/console", "/openapi.json", "/health", "/screener", "/screener-accum", "/cache-summary", "/features/history"]);

// ==============================
// CORS helper
// ==============================
function withCORS(resp) {
  const headers = new Headers(resp.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");

  return new Response(resp.body, {
    status: resp.status || 200,
    headers
  });
}

function shouldRepairFootprint({ candles, dateStr, completion, missingSessionHours, brokenFound }) {
  const nowWIB = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const todayWIB = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth() + 1).padStart(2, "0")}-${String(nowWIB.getDate()).padStart(2, "0")}`;
  const isPastDay = dateStr !== todayWIB;

  const noData = !candles || candles.length === 0;

  const reason = completion?.reason || null;
  const isSparse = reason === "SPARSE_DATA";

  const incompleteNotSparse =
    completion?.isIncomplete && !isSparse;

  // IMPORTANT:
  // - missingSessionHours hanya meaningful untuk PAST DAY, dan hanya kalau bukan SPARSE
  const missingHeuristic =
    isPastDay && !isSparse && (missingSessionHours >= 2);

  const repair =
    noData ||
    brokenFound ||
    incompleteNotSparse ||
    missingHeuristic;

  // priority: kalau datanya ada tapi incomplete (non-sparse) -> high
  const priority = (incompleteNotSparse && !noData) ? "high" : "normal";

  const missingRatio = missingSessionHours / 8; // 02..09 UTC (8 jam)

  return { repair, priority, missingSessionHours, missingRatio, reason };
}

function isRepairEnabled(env) {
  const raw = env?.REPAIR_ENABLED;
  if (raw === undefined || raw === null) return true;

  if (typeof raw === "boolean") return raw;

  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    return !["0", "false", "off", "no"].includes(value);
  }

  return Boolean(raw);
}

async function countMissingSessionHours(env, kode, dateStr) {
  const [y, m, d] = dateStr.split("-");
  let missing = 0;

  // NOTE: we check hour-segment objects 02..09 UTC (8 segments).
  // This is a storage-segment heuristic, NOT "market duration" hours.
  for (let hh = 2; hh <= 9; hh++) {
    const hStr = String(hh).padStart(2, "0");
    const key = `footprint/${kode}/1m/${y}/${m}/${d}/${hStr}.jsonl`;
    const obj = await env.FOOTPRINT_BUCKET.head(key);
    if (!obj) missing++;
  }
  return missing;
}

function resolveOHLC(candle) {
  const isFiniteNumber = (val) => typeof val === "number" && Number.isFinite(val);
  const ohlc = candle?.ohlc || {};

  const fallbackBase = isFiniteNumber(candle?.open)
    ? candle.open
    : isFiniteNumber(candle?.close)
    ? candle.close
    : isFiniteNumber(candle?.price)
    ? candle.price
    : 0;

  const open = isFiniteNumber(ohlc.o) ? ohlc.o : fallbackBase;
  const close = isFiniteNumber(ohlc.c)
    ? ohlc.c
    : isFiniteNumber(candle?.close)
    ? candle.close
    : fallbackBase;

  const high = isFiniteNumber(ohlc.h) ? ohlc.h : Math.max(open, close);
  const low = isFiniteNumber(ohlc.l) ? ohlc.l : Math.min(open, close);

  return { open, high, low, close };
}


// ==============================
// UTC Trading Calendar Helpers
// ==============================
// Use T12:00Z to avoid timezone edge-shifts
function isWeekendUTC(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun,6=Sat
  return dow === 0 || dow === 6;
}

function prevTradingDayUTC(dateStr) {
  let d = new Date(`${dateStr}T12:00:00Z`);
  do {
    d = new Date(d.getTime() - 86400000); // -1 day
  } while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}


function json(data, status = 200, extraHeaders = {}) {
  return withCORS(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders
      }
    })
  );
}

function buildEmitenQuery(filters = {}) {
  const clauses = [];
  const params = [];

  const status = normalizeStatusFilter(filters.status);
  if (status) {
    clauses.push("status = ? COLLATE NOCASE");
    params.push(status);
  }

  const sector = normalizeSectorFilter(filters.sector);
  if (sector) {
    clauses.push("sector = ? COLLATE NOCASE");
    params.push(sector);
  }

  const q = normalizeSearchQuery(filters.q);
  if (q) {
    clauses.push("ticker LIKE ? COLLATE NOCASE");
    params.push(`%${q}%`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = clampLimit(filters.limit);

  const sql = `
    SELECT ticker, sector, industry, status, created_at, updated_at
    FROM emiten
    ${whereClause}
    ORDER BY ticker ASC
    LIMIT ?
  `;

  params.push(limit);
  return { sql, params };
}

async function fetchEmitenList(env, filters = {}) {
  if (!env?.SSSAHAM_DB?.prepare) {
    throw new Error("SSSAHAM_DB binding is missing");
  }

  const { sql, params } = buildEmitenQuery(filters);
  const statement = env.SSSAHAM_DB.prepare(sql);
  const runner = params.length ? statement.bind(...params) : statement;
  const { results } = await runner.all();
  return (results || []).map((row) => ({
    ticker: row.ticker,
    sector: row.sector ?? null,
    industry: row.industry ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null
  }));
}

function clampLimit(limitValue, defaultValue = 500) {
  if (limitValue === undefined || limitValue === null || limitValue === "") {
    return defaultValue;
  }

  const num = Number(limitValue);
  if (!Number.isFinite(num)) return defaultValue;
  const clamped = Math.min(Math.max(Math.floor(num), 1), 2000);
  return clamped;
}

function normalizeStatusFilter(value) {
  if (value === undefined || value === null) return "ACTIVE";
  const upper = String(value).trim().toUpperCase();
  if (!upper) return "ACTIVE";
  if (upper === "ALL") return null;
  return upper;
}

function normalizeSectorFilter(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeSearchQuery(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\%_]/g, "");
}

function getIdxSyncToken(env) {
  const raw = env?.IDX_SYNC_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function requireIdxAdmin(req, env) {
  const token = getIdxSyncToken(env);
  if (!token) {
    return { ok: false, response: json({ error: "IDX_SYNC_TOKEN not configured" }, 500) };
  }

  const provided = normalizeTokenHeader(req.headers.get("x-admin-token")) || extractBearerToken(req.headers.get("authorization"));
  if (provided && provided === token) {
    return { ok: true };
  }

  return { ok: false, response: json({ error: "Unauthorized" }, 401) };
}

function normalizeTokenHeader(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function extractBearerToken(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeTokenHeader(match[1]) : null;
}

async function proxyIdxSync(env) {
  if (!env?.IDX_HANDLER?.fetch) {
    throw new Error("IDX_HANDLER binding is missing");
  }

  const headers = new Headers({ "content-type": "application/json" });
  const token = getIdxSyncToken(env);
  if (token) headers.set("x-admin-token", token);

  const resp = await env.IDX_HANDLER.fetch("https://idx-handler/internal/idx/sync-emiten", {
    method: "POST",
    headers
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = { raw: text || null };
  }

  return { status: resp.status, data };
}

// ==============================
// LOGIC: Aggregation (Ported)
// ==============================

// ==============================
// LOGIC: Footprint Range Aggregator (v3)
// ==============================
async function calculateFootprintRange(env, fromDateStr, toDateStr) {
  // 1. Time Locking Strategy
  // Start: 09:00 WIB (02:00 UTC) on fromDate
  const startTs = new Date(`${fromDateStr}T02:00:00Z`).getTime();

  // End: 
  // If toDate is Today (UTC date matches), use NOW.
  // If toDate is Past, use 16:00 WIB (09:00 UTC).
  const now = new Date();
  const toDate = new Date(toDateStr);
  const todayStr = now.toISOString().split("T")[0];

  let endTs;
  if (toDateStr === todayStr) {
    endTs = now.getTime();
  } else {
    endTs = new Date(`${toDateStr}T09:00:00Z`).getTime();
  }

  console.log(`[RANGE] Aggregating ${fromDateStr} to ${toDateStr} (${startTs} - ${endTs})`);

  // 2. Fetch Footprint Aggregates (L1)
  const { results } = await env.SSSAHAM_DB.prepare(`
  SELECT 
      ticker,
      SUM(vol) as total_vol,
      SUM(delta) as total_delta,
      MIN(time_key) as first_time,
      MAX(time_key) as last_time,

      -- prefer true high/low, fallback to close if high/low missing/bad
      MAX(CASE WHEN high IS NOT NULL AND high > 0 THEN high ELSE close END) AS high,
      MIN(CASE WHEN low  IS NOT NULL AND low  > 0 THEN low  ELSE close END) AS low,

      -- keep close-range too (debug/telemetry)
      MAX(close) AS close_hi,
      MIN(close) AS close_lo

  FROM temp_footprint_consolidate
  WHERE time_key >= ? AND time_key <= ?
  GROUP BY ticker
`).bind(startTs, endTs).all();



  if (!results || results.length === 0) return { items: [] };

  // 3. Enrich with OHLC (Open from first_time, Close from last_time)
  // We fetch open/close in batches to avoid N+1
  const enriched = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const chunk = results.slice(i, i + BATCH_SIZE);
    const conditions = chunk.map(r => {
      const t = String(r.ticker || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, ""); // keep it strict

      const first = Number(r.first_time) || 0;
      const last = Number(r.last_time) || 0;

      if (!t || !first || !last) return null;
      return `(ticker = '${t}' AND time_key IN (${first}, ${last}))`;
    }).filter(Boolean).join(" OR ");

    if (conditions) {
      const { results: ohlc } = await env.SSSAHAM_DB.prepare(`
                SELECT ticker, time_key, open, close
                FROM temp_footprint_consolidate
                WHERE ${conditions}
            `).all();

      const mapped = chunk.map(row => {
        const matches = ohlc.filter(r => r.ticker === row.ticker);
        const openRow = matches.find(r => r.time_key === row.first_time);
        const closeRow = matches.find(r => r.time_key === row.last_time);
        const open = openRow ? openRow.open : (closeRow ? closeRow.open : 0);
        const close = closeRow ? closeRow.close : (openRow ? openRow.close : 0);
        return { ...row, open, close };
      });
      enriched.push(...mapped);
    } else {
      enriched.push(...chunk);
    }
  }

  // 4. Fetch Context (L2) - From StartDate - 1 Day
  // We assume 'daily_features' has entry for prev day.
  const ctxRow = await env.SSSAHAM_DB.prepare(`
        SELECT MAX(date) as ctx_date FROM daily_features WHERE date < ?
    `).bind(fromDateStr).first();

  const contextMap = new Map();
  if (ctxRow && ctxRow.ctx_date) {
    const { results: ctxList } = await env.SSSAHAM_DB.prepare(`
            SELECT ticker, state as hist_state, z_ngr as hist_z_ngr
            FROM daily_features
            WHERE date = ?
        `).bind(ctxRow.ctx_date).all();
    if (ctxList) ctxList.forEach(c => contextMap.set(c.ticker, c));
  }

  // 5. Calculate Hybrid Scores
  const items = enriched.map(fp => {
    const ctx = contextMap.get(fp.ticker) || {};
    return calculateHybridItem(fp, ctx);
  }).filter(i => i !== null);

  // 6. Return Format
  return {
    generated_at: new Date().toISOString(),
    range: { from: fromDateStr, to: toDateStr },
    count: items.length,
    items: items
  };
}

// Helpers (Ported from features-service)
function normalize(value, min, max) {
  if (max === min) return 0.5;
  const n = (value - min) / (max - min);
  return Math.max(0, Math.min(1, n));
}

/**
 * Checks if the fetched footprint data is complete based on market hours.
 * NOTE:
 * - Source is 1m rows, BUT completeness uses "5m activity buckets" heuristic:
 *   expectedBuckets5m ~ how many 5-minute windows should have activity for non-sparse tickers.
 * - This prevents sparse tickers from being treated as "broken/incomplete".
 *
 * Market hours: 09:00 - 16:00 WIB (02:00 - 09:00 UTC)
 */
function checkDataCompleteness(candles, dateStr) {
  if (!candles || candles.length === 0) {
    return { isIncomplete: true, reason: "NO_DATA" };
  }

  const now = new Date();
  const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const todayWIBStr = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth() + 1).padStart(2, "0")}-${String(nowWIB.getDate()).padStart(2, "0")}`;
  const nowUTC = now.toISOString().slice(11, 16);
  const nowWIBTime = `${String(nowWIB.getHours()).padStart(2, "0")}:${String(nowWIB.getMinutes()).padStart(2, "0")}`;

  const isToday = dateStr === todayWIBStr;
  const dayOfWeek = nowWIB.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // pick last traded candle if possible (vol>0), else fallback to last row
  const lastTraded = [...candles].reverse().find(c => (c?.vol || 0) > 0) || candles[candles.length - 1];
  const lastCandleDate = new Date(lastTraded.t0);
  const lastCandleWIB = new Date(lastCandleDate.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const lastCandleUTC = lastCandleDate.toISOString().slice(11, 16);
  const lastWIBTime = `${String(lastCandleWIB.getHours()).padStart(2, "0")}:${String(lastCandleWIB.getMinutes()).padStart(2, "0")}`;

  const marketOpenHour = 9;
  const marketCloseHour = 16;

  console.log(`[COMPLETION] ========================================`);
  console.log(`[COMPLETION] dateStr=${dateStr}, isToday=${isToday}`);
  console.log(`[COMPLETION] NOW: ${nowWIBTime} WIB (${nowUTC} UTC), Weekend=${isWeekend}`);
  console.log(`[COMPLETION] Last traded: ${lastWIBTime} WIB (${lastCandleUTC} UTC)`);
  console.log(`[COMPLETION] Row count: ${candles.length}`);

  // Count traded rows only
  const tradedRows = candles.reduce((n, c) => n + (((c?.vol || 0) > 0) ? 1 : 0), 0);

  // Expected "activity buckets" in 5-minute windows (heuristic)
  let expectedBuckets5m = 0;

  if (isToday && !isWeekend && nowWIB.getHours() >= marketOpenHour) {
    const nowH = nowWIB.getHours();
    const nowM = nowWIB.getMinutes();
    const effectiveEndH = Math.min(nowH, marketCloseHour);
    const effectiveEndM = nowH < marketCloseHour ? nowM : 0;

    const elapsedMins = Math.max(0, (effectiveEndH - marketOpenHour) * 60 + effectiveEndM);
    expectedBuckets5m = Math.floor(elapsedMins / 5);
    console.log(`[COMPLETION] Today buckets: ~${expectedBuckets5m} (elapsed ${elapsedMins} mins / 5)`);
  } else if (!isToday) {
    expectedBuckets5m = 84; // 09:00-16:00 WIB = 7h => 420 mins / 5 = 84 buckets
    console.log(`[COMPLETION] Past day buckets: ~84`);
  }

  // Sparse check with 50% tolerance (allow sparse stocks like CASA)
  const sparseThreshold = Math.max(Math.floor(expectedBuckets5m * 0.5), 5);
  console.log(`[COMPLETION] Sparse threshold: ${sparseThreshold} (50% of ${expectedBuckets5m})`);
  console.log(`[COMPLETION] Traded rows: ${tradedRows}`);

  if (expectedBuckets5m > 0 && tradedRows < sparseThreshold) {
    console.log(`[COMPLETION] RESULT: SPARSE_DATA (${tradedRows} < ${sparseThreshold})`);
    return {
      isIncomplete: true,
      reason: "SPARSE_DATA",
      tradedRows,
      expectedBuckets5m,
      threshold: sparseThreshold
    };
  }

  // Past Day Completeness: should reach at least 15:50 WIB (non-sparse only, because sparse already returned above)
  if (!isToday) {
    const lastH = lastCandleWIB.getHours();
    const lastM = lastCandleWIB.getMinutes();

    if (lastH < 15 || (lastH === 15 && lastM < 50)) {
      console.log(`[COMPLETION] RESULT: PAST_DAY_INCOMPLETE (last traded ${lastWIBTime}, expected >= 15:50)`);
      return { isIncomplete: true, reason: "PAST_DAY_INCOMPLETE", last: lastWIBTime };
    }
  } else if (!isWeekend) {
    // Today stale check: during market hours, last traded should be within 20 mins
    const nowH = nowWIB.getHours();
    if (nowH >= marketOpenHour && nowH < marketCloseHour) {
      const diffMs = nowWIB.getTime() - lastCandleWIB.getTime();
      if (diffMs > 20 * 60000) {
        console.log(`[COMPLETION] RESULT: TODAY_STALE (${Math.floor(diffMs / 60000)} mins)`);
        return { isIncomplete: true, reason: "TODAY_STALE", diffMins: Math.floor(diffMs / 60000) };
      }
    }
  }

  console.log(`[COMPLETION] RESULT: COMPLETE ✓`);
  return { isIncomplete: false, expectedBuckets5m, tradedRows };
}


function getSignal(score, deltaPct, histZNGR, histState, pricePct) {
  // Hybrid Signal Alignment
  const isAccum = histState === 'ACCUMULATION';
  const isDistrib = histState === 'DISTRIBUTION';
  const isBuying = deltaPct > 0;
  const isSelling = deltaPct < 0;
  const isPriceUp = pricePct > 0;

  // 1. STRONG BUY: Historical Accumulation + Today Buying + High Score
  if (isAccum && isBuying && score > 0.75) return 'STRONG_BUY';

  // 2. MARKUP: Strong Buying + Price Up (Momentum)
  if (isBuying && isPriceUp && score > 0.8) return 'MARKUP';

  // 3. TRAP WARNING: Distribution Context + Today Buying (Fakeout)
  if (isDistrib && isBuying) return 'TRAP_WARNING';

  // 4. HIDDEN ACCUM: Low Price/Drop + Buying Pressure (Absorption)
  if (!isPriceUp && isBuying && isAccum) return 'HIDDEN_ACCUM';

  // 5. STRONG SELL: Distribution + Selling
  if (isDistrib && isSelling && score < 0.25) return 'STRONG_SELL';

  if (score > 0.6) return 'BUY';
  if (score < 0.4) return 'SELL';

  return 'NEUTRAL';
}

function calculateHybridItem(footprint, context) {
  const open = footprint.open || 0;
  const close = footprint.close || 0;
  const vol = footprint.total_vol || 0;
  const delta = footprint.total_delta || 0;
  const high = footprint.high || close;
  const low = footprint.low || close;

  if (vol === 0 || open === 0) return null;

  const deltaPct = (delta / vol) * 100;
  const pricePct = ((close - open) / open) * 100;

  // NEW: Calculate missing fields
  const range = high - low;
  const fluktuasi = close > 0 ? ((high - low) / close) * 100 : 0;
  const absCvd = Math.abs(deltaPct) / (1 + Math.abs(pricePct)); // Normalized Absorption Score

  // Real-Time Component (70%)
  // Normalize Delta: Expecting -25% to +25% as significant range (Net Delta)
  const normDelta = normalize(deltaPct, -25, 25);
  // Normalize Price: Expecting -5% to +5% as significant day range
  const normPrice = normalize(pricePct, -5, 5);
  const rtScore = (0.7 * normDelta) + (0.3 * normPrice);

  // Historical Component (30%)
  const hist_z_ngr = context.hist_z_ngr || 0;
  const hist_state = context.hist_state || 'NEUTRAL';

  // Normalize Z-Score: -3 to +3
  let normZNGR = normalize(hist_z_ngr, -3, 3);

  // State Boost/Penalty
  if (hist_state === 'ACCUMULATION') normZNGR += 0.1; // Boost
  if (hist_state === 'DISTRIBUTION') normZNGR -= 0.1; // Penalty

  // Clamp Score
  const histScore = Math.max(0, Math.min(1, normZNGR));

  // Final Hybrid Formula
  const hybridScore = (0.7 * rtScore) + (0.3 * histScore);

  const signal = getSignal(hybridScore, deltaPct, hist_z_ngr, hist_state, pricePct);

  return {
    t: footprint.ticker,
    d: parseFloat(deltaPct.toFixed(2)),
    p: parseFloat(pricePct.toFixed(2)),
    v: vol,
    h: high,
    l: low,
    r: range,
    f: parseFloat(fluktuasi.toFixed(2)),
    div: parseFloat(absCvd.toFixed(2)),
    ctx_net: parseFloat(hist_z_ngr.toFixed(2)),
    ctx_st: hist_state,
    sc: parseFloat(hybridScore.toFixed(3)),
    sig: signal
  };
}

async function fetchLiveBrokerSnapshot(env, symbol, dateStr) {
  if (!env?.BROKSUM_SERVICE) return null;
  try {
    const u = `http://internal/ipot/scrape?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(dateStr)}&to=${encodeURIComponent(dateStr)}&save=false&debug=false`;
    const r = await env.BROKSUM_SERVICE.fetch(u);
    if (!r || !r.ok) return null;
    const j = await r.json();
    const data = j?.data || null;
    if (!data) return null;
    return {
      broker_summary: data.broker_summary || null,
      bandar_detector: data.bandar_detector || null
    };
  } catch (e) {
    console.error(`[LIVE REPAIR] fetch failed ${symbol} ${dateStr}:`, e?.message || e);
    return null;
  }
}

function hasBrokerRows(bs) {
  if (!bs) return false;
  const buy = Array.isArray(bs.brokers_buy) ? bs.brokers_buy.length : 0;
  const sell = Array.isArray(bs.brokers_sell) ? bs.brokers_sell.length : 0;
  return buy > 0 || sell > 0;
}

async function calculateRangeData(env, ctx, symbol, startDate, endDate) {
  const results = [];
  const accBrokers = {};
  const errors = [];

  // 0. Fetch Brokers Mapping
  let brokersMap = {};
  try {
    const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
    if (results) {
      results.forEach(b => brokersMap[b.code] = b);
    }
  } catch (e) {
    console.error("Error fetching brokers mapping:", e);
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Loop through dates
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    // Skip weekends
    if (isWeekendUTC(dateStr)) continue;

    const key = `${symbol}/${dateStr}.json`; // Key format from scrapper

    try {
      const object = await env.RAW_BROKSUM.get(key);
      if (object) {
        const fullOuter = await object.json();
        if (fullOuter && fullOuter.data) {
          let bd = fullOuter.data.bandar_detector;
          let bs = fullOuter.data.broker_summary;

          // Live repair: if RAW exists but broker rows are empty, pull single-day snapshot from scraper.
          if (!hasBrokerRows(bs)) {
            const repaired = await fetchLiveBrokerSnapshot(env, symbol, dateStr);
            if (hasBrokerRows(repaired?.broker_summary)) {
              bs = repaired.broker_summary;
              if (repaired.bandar_detector) bd = repaired.bandar_detector;
            }
          }

          // 1. Calculate Daily Flow
          let foreignBuy = 0, foreignSell = 0;
          let retailBuy = 0, retailSell = 0;
          let localBuy = 0, localSell = 0;

          const isRetail = (code) => {
            const b = brokersMap[code];
            if (!b) return false;
            const cat = (b.category || '').toLowerCase();
            return cat.includes('retail');
          };

          // 2. Aggregate Broker Summary
          if (bs) {
            const process = (list, type) => {
              if (list && Array.isArray(list)) {
                list.forEach(b => {
                  if (!b) return;
                  const val = parseFloat(type === 'buy' ? b.bval : b.sval) || 0;
                  const vol = parseFloat(type === 'buy' ? b.blotv || b.blot * 100 : b.slotv || b.slot * 100) || 0;
                  const code = b.netbs_broker_code;

                  if (type === 'buy') {
                    if (isRetail(code)) retailBuy += val;
                    else if (b.type === "Asing") foreignBuy += val;
                    else localBuy += val;

                    if (code) {
                      if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                      accBrokers[code].bval += val;
                      accBrokers[code].bvol += vol;
                    }
                  } else {
                    if (isRetail(code)) retailSell += val;
                    else if (b.type === "Asing") foreignSell += val;
                    else localSell += val;

                    if (code) {
                      if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                      accBrokers[code].sval += val;
                      accBrokers[code].svol += vol;
                    }
                  }
                });
              }
            };
            process(bs.brokers_buy, 'buy');
            process(bs.brokers_sell, 'sell');
          }

          const summary = {
            detector: bd,
            price: bs?.stock_summary?.average_price ? parseInt(bs.stock_summary.average_price) : 0,
            foreign: { buy_val: foreignBuy, sell_val: foreignSell, net_val: foreignBuy - foreignSell },
            retail: { buy_val: retailBuy, sell_val: retailSell, net_val: retailBuy - retailSell },
            local: { buy_val: localBuy, sell_val: localSell, net_val: localBuy - localSell }
          };
          results.push({ date: dateStr, data: summary });
        }
      } else {
        // RAW missing for this trading day: try live scrape to avoid undercounted range totals.
        const repaired = await fetchLiveBrokerSnapshot(env, symbol, dateStr);
        if (repaired && hasBrokerRows(repaired.broker_summary)) {
          const bd = repaired.bandar_detector;
          const bs = repaired.broker_summary;

          let foreignBuy = 0, foreignSell = 0;
          let retailBuy = 0, retailSell = 0;
          let localBuy = 0, localSell = 0;

          const isRetail = (code) => {
            const b = brokersMap[code];
            if (!b) return false;
            const cat = (b.category || '').toLowerCase();
            return cat.includes('retail');
          };

          const process = (list, type) => {
            if (list && Array.isArray(list)) {
              list.forEach(b => {
                if (!b) return;
                const val = parseFloat(type === 'buy' ? b.bval : b.sval) || 0;
                const vol = parseFloat(type === 'buy' ? b.blotv || b.blot * 100 : b.slotv || b.slot * 100) || 0;
                const code = b.netbs_broker_code;

                if (type === 'buy') {
                  if (isRetail(code)) retailBuy += val;
                  else if (b.type === "Asing") foreignBuy += val;
                  else localBuy += val;

                  if (code) {
                    if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                    accBrokers[code].bval += val;
                    accBrokers[code].bvol += vol;
                  }
                } else {
                  if (isRetail(code)) retailSell += val;
                  else if (b.type === "Asing") foreignSell += val;
                  else localSell += val;

                  if (code) {
                    if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                    accBrokers[code].sval += val;
                    accBrokers[code].svol += vol;
                  }
                }
              });
            }
          };

          process(bs.brokers_buy, 'buy');
          process(bs.brokers_sell, 'sell');

          const summary = {
            detector: bd,
            price: bs?.stock_summary?.average_price ? parseInt(bs.stock_summary.average_price) : 0,
            foreign: { buy_val: foreignBuy, sell_val: foreignSell, net_val: foreignBuy - foreignSell },
            retail: { buy_val: retailBuy, sell_val: retailSell, net_val: retailBuy - retailSell },
            local: { buy_val: localBuy, sell_val: localSell, net_val: localBuy - localSell }
          };
          results.push({ date: dateStr, data: summary });
        }
      }
    } catch (e) {
      // ignore missing
    }
  }

  // 6. On-Demand Backfill Trigger (If results empty)
  // Logic: If user requests data < 30 days ago, and we have 0 results, trigger backfill.
  // 6. On-Demand Backfill Trigger (If data incomplete or empty)
  // Calculate expected trading days (rough estimate: 70% of calendar days)
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const expectedTradingDays = Math.floor(diffDays * 0.7); // ~5 days per week
  const actualDays = results.length;
  const completeness = expectedTradingDays > 0 ? actualDays / expectedTradingDays : 0;

  console.log(`[DATA CHECK] ${symbol}: Expected ${expectedTradingDays}, Got ${actualDays}, Completeness: ${(completeness * 100).toFixed(1)}%`);

  // Trigger backfill if EMPTY or INCOMPLETE
  if (results.length === 0 || completeness < 0.7) { // Less than 70% complete
    if (env.BROKSUM_SERVICE) {
      const reason = results.length === 0 ? 'empty' : `incomplete (${(completeness * 100).toFixed(1)}%)`;
      console.log(`[BACKFILL] Triggering for ${symbol}: ${reason}`);

      // Fire & Forget
      const p = env.BROKSUM_SERVICE.fetch(
        `http://internal/auto-backfill?symbol=${encodeURIComponent(symbol)}&days=90&force=false`
      ).catch(e => console.error("Backfill Trigger Failed:", e));

      if (ctx?.waitUntil) ctx.waitUntil(p);


      if (results.length === 0) {
        return {
          generated_at: new Date().toISOString(),
          backfill_active: true, // Signal to Frontend
          completeness: completeness,
          expected_days: expectedTradingDays,
          actual_days: actualDays,
          history: [],
          summary: {
            foreign: { buy_val: 0, sell_val: 0, net_val: 0 },
            retail: { buy_val: 0, sell_val: 0, net_val: 0 },
            local: { buy_val: 0, sell_val: 0, net_val: 0 }
          }
        };
      }

      // Partial Data: Return what we have + flag
      // We continue to return `results` but we need to inject the flag into the final response logic.
      // The return structure of `calculateRangeData` is { history, summary }.
      // We can attach extra metadata property? No, caller expects {history, summary}.
      // But the caller (GET /cache-summary) wraps this in JSON.
      // We should attach the flag to the return object.
    }
  }

  // Format Top Brokers
  const format = (type) => Object.keys(accBrokers)
    .map(k => ({ code: k, ...accBrokers[k] }))
    .sort((a, b) => b[type] - a[type])
    .slice(0, 20);

  const allNet = Object.keys(accBrokers).map(k => ({
    code: k, ...accBrokers[k], net: accBrokers[k].bval - accBrokers[k].sval
  }));

  // Calculate Aggregated Stats for the Range
  let aggForeign = { buy: 0, sell: 0, net: 0 };
  let aggRetail = { buy: 0, sell: 0, net: 0 };
  let aggLocal = { buy: 0, sell: 0, net: 0 };

  results.forEach(r => {
    if (r.data) {
      aggForeign.buy += r.data.foreign?.buy_val || 0;
      aggForeign.sell += r.data.foreign?.sell_val || 0;

      aggRetail.buy += r.data.retail?.buy_val || 0;
      aggRetail.sell += r.data.retail?.sell_val || 0;

      aggLocal.buy += r.data.local?.buy_val || 0;
      aggLocal.sell += r.data.local?.sell_val || 0;
    }
  });

  aggForeign.net = aggForeign.buy - aggForeign.sell;
  aggRetail.net = aggRetail.buy - aggRetail.sell;
  aggLocal.net = aggLocal.buy - aggLocal.sell;

  // Determine backfill status for Partial Data
  const isIncomplete = completeness < 0.7;

  return {
    backfill_active: isIncomplete ? true : false,
    completeness: completeness,
    history: results,
    summary: {
      top_buyers: format('bval'),
      top_sellers: format('sval'),
      top_net_buyers: allNet.filter(b => b.net > 0).sort((a, b) => b.net - a.net).slice(0, 20),
      top_net_sellers: allNet.filter(b => b.net < 0).sort((a, b) => a.net - b.net).slice(0, 20),
      // Added Aggregates for Frontend Summary
      foreign: { buy_val: aggForeign.buy, sell_val: aggForeign.sell, net_val: aggForeign.net },
      retail: { buy_val: aggRetail.buy, sell_val: aggRetail.sell, net_val: aggRetail.net },
      local: { buy_val: aggLocal.buy, sell_val: aggLocal.sell, net_val: aggLocal.net }
    }
  };
}

function getTodayOrderflowWindow(now = new Date()) {
  const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const year = nowWIB.getFullYear();
  const month = String(nowWIB.getMonth() + 1).padStart(2, "0");
  const day = String(nowWIB.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  const sessionStartUTC = new Date(`${dateStr}T02:00:00Z`).getTime();
  const sessionEndUTC = new Date(`${dateStr}T09:00:00Z`).getTime();

  let endTs = now.getTime();
  if (endTs < sessionStartUTC) endTs = sessionStartUTC;
  if (endTs > sessionEndUTC) endTs = sessionEndUTC;

  return { dateStr, startTs: sessionStartUTC, endTs };
}

function mapQuadrant(deltaPct, pricePct) {
  if (deltaPct >= 0 && pricePct >= 0) return "Q1";
  if (deltaPct < 0 && pricePct >= 0) return "Q2";
  if (deltaPct < 0 && pricePct < 0) return "Q3";
  return "Q4";
}

function toOrderflowBubblePoint(symbol, snapshot) {
  if (!snapshot) return null;
  return {
    ticker: symbol,
    x: snapshot.delta_pct,
    y: snapshot.mom_pct,
    r: snapshot.net_value || 0,
    quadrant: snapshot.quadrant,
    absorb: snapshot.absorb,
    score: snapshot.score ?? null,
    snapshot_at: snapshot.snapshot_at
  };
}

function buildFromFallbackTimeline(kode, dateStr, fallbackData) {
  const timeline = Array.isArray(fallbackData?.timeline) ? fallbackData.timeline : [];

  const buckets = [];
  const tableData = [];
  const candles = [];

  for (const entry of timeline) {
    if (!entry || typeof entry.t !== "string") continue;

    const tStr = entry.t.trim(); // "HH:MM"
    // WIB timestamp (safe parsing)
    const ts = new Date(`${dateStr}T${tStr}:00+07:00`).getTime();

    const p = Number(entry.p || 0);
    const v = Number(entry.v || 0);
    const a = Number(entry.a || 0);

    // If m not present, derive from delta/vol
    const mRaw = entry.m ?? (v > 0 ? (a / v) * 50 + 50 : 50);
    const m = Number(Number(mRaw).toFixed(2));

    // absCvd heuristic (same shape as your tableData)
    const abs = v > 0 ? (Math.abs(a / v) * 100) / (1 + 0) : 0;

    // Candles: fallback only has 1 price, so flat OHLC
    candles.push({ x: ts, o: p, h: p, l: p, c: p });

    // Table rows
    tableData.push({
      t: tStr,
      x: ts,
      p,
      v,
      a,
      m,
      abs: Number(abs.toFixed(2))
    });

    // Buckets: match your existing fallback-bubble shape
    buckets.push({
      t: tStr,
      x: ts,
      p,
      v,
      m,
      a,
      is_fallback: true,
      side: a >= 0 ? "buy" : "sell"
    });
  }

  buckets.sort((a, b) => a.x - b.x);
  tableData.sort((a, b) => a.x - b.x);
  candles.sort((a, b) => a.x - b.x);

  return { buckets, tableData, candles };
}


async function getOrderflowSnapshot(env, symbol) {
  if (!env?.SSSAHAM_DB || !symbol) return null;

  const normalizedSymbol = symbol.toUpperCase();
  const { dateStr, startTs, endTs } = getTodayOrderflowWindow();

  try {
    const aggregate = await env.SSSAHAM_DB.prepare(`
      SELECT 
        SUM(vol) as total_vol,
        SUM(delta) as total_delta,
        MIN(time_key) as first_ts,
        MAX(time_key) as last_ts,
        MAX(high) as high,
        MIN(low) as low
      FROM temp_footprint_consolidate
      WHERE ticker = ? AND time_key >= ? AND time_key <= ?
    `).bind(normalizedSymbol, startTs, endTs).first();

    if (!aggregate || !aggregate.total_vol || aggregate.total_vol <= 0 || !aggregate.first_ts || !aggregate.last_ts) {
      return null;
    }

    const { results: ocRows = [] } = await env.SSSAHAM_DB.prepare(`
  SELECT time_key, open, close
  FROM temp_footprint_consolidate
  WHERE ticker = ? AND time_key IN (?, ?)
`).bind(normalizedSymbol, aggregate.first_ts, aggregate.last_ts).all();

    const firstRow = ocRows.find(r => r.time_key === aggregate.first_ts) || ocRows[0] || {};
    const lastRow = ocRows.find(r => r.time_key === aggregate.last_ts) || ocRows[ocRows.length - 1] || {};

    const open = Number(firstRow.open || lastRow.open || 0);
    const close = Number(lastRow.close || firstRow.close || 0);

    if (!open || !close) return null;

    const ctx = await env.SSSAHAM_DB.prepare(`
      SELECT state as hist_state, z_ngr as hist_z_ngr
      FROM daily_features
      WHERE ticker = ? AND date < ?
      ORDER BY date DESC
      LIMIT 1
    `).bind(normalizedSymbol, dateStr).first() || {};

    const hybridInput = {
      ticker: normalizedSymbol,
      open,
      close,
      total_vol: Number(aggregate.total_vol) || 0,
      total_delta: Number(aggregate.total_delta) || 0,
      high: Number(aggregate.high || close),
      low: Number(aggregate.low || close)
    };

    const hybrid = calculateHybridItem(hybridInput, {
      hist_state: ctx.hist_state,
      hist_z_ngr: ctx.hist_z_ngr
    });

    if (!hybrid) return null;

    const netValue = hybrid.v && close ? hybrid.v * close : null;
    const snapshotAt = aggregate.last_ts ? new Date(aggregate.last_ts).toISOString() : new Date().toISOString();

    return {
      ticker: normalizedSymbol,
      price: close,
      delta_pct: hybrid.d,
      price_pct: hybrid.p,
      mom_pct: hybrid.p,
      absorb: hybrid.div,
      cvd: Number(aggregate.total_delta || 0),
      net_value: netValue,
      volume: hybrid.v,
      range: hybrid.r,
      score: hybrid.sc,
      signal: hybrid.sig,
      quadrant: mapQuadrant(hybrid.d, hybrid.p),
      context_state: hybrid.ctx_st,
      context_z: hybrid.ctx_net,
      snapshot_at: snapshotAt,
      generated_at: new Date().toISOString(),
      source: "d1"
    };
  } catch (err) {
    console.error("[orderflow] snapshot failed:", err);
    return null;
  }
}

async function getOrderflowSnapshotMap(env) {
  if (!env?.SSSAHAM_DB) return {};

  const { dateStr, startTs, endTs } = getTodayOrderflowWindow();

  try {
    const { results: rows = [] } = await env.SSSAHAM_DB.prepare(`
      SELECT ticker, time_key, open, close, vol, delta, high, low
      FROM temp_footprint_consolidate
      WHERE time_key >= ? AND time_key <= ?
      ORDER BY ticker ASC, time_key ASC
    `).bind(startTs, endTs).all();

    if (!rows.length) return {};

    const aggMap = new Map();
    for (const row of rows) {
      const ticker = String(row?.ticker || "").toUpperCase();
      if (!ticker) continue;

      const vol = Number(row?.vol || 0);
      const delta = Number(row?.delta || 0);
      const open = Number(row?.open || 0);
      const close = Number(row?.close || 0);
      const high = Number(row?.high || close || open || 0);
      const low = Number(row?.low || close || open || 0);
      const ts = Number(row?.time_key || 0);

      if (!aggMap.has(ticker)) {
        aggMap.set(ticker, {
          ticker,
          open,
          close,
          total_vol: 0,
          total_delta: 0,
          high,
          low,
          first_ts: ts,
          last_ts: ts
        });
      }

      const agg = aggMap.get(ticker);
      if (!agg.open && open) agg.open = open;
      if (close) agg.close = close;
      agg.total_vol += vol;
      agg.total_delta += delta;
      agg.high = Math.max(agg.high || high, high);
      agg.low = Math.min(agg.low || low, low);
      if (ts && (!agg.first_ts || ts < agg.first_ts)) agg.first_ts = ts;
      if (ts && (!agg.last_ts || ts > agg.last_ts)) agg.last_ts = ts;
    }

    const ctxMap = new Map();
    try {
      const { results: ctxRows = [] } = await env.SSSAHAM_DB.prepare(`
        SELECT d.ticker, d.state as hist_state, d.z_ngr as hist_z_ngr
        FROM daily_features d
        INNER JOIN (
          SELECT ticker, MAX(date) as max_date
          FROM daily_features
          WHERE date < ?
          GROUP BY ticker
        ) m
          ON d.ticker = m.ticker AND d.date = m.max_date
      `).bind(dateStr).all();

      for (const c of ctxRows) {
        const t = String(c?.ticker || "").toUpperCase();
        if (!t) continue;
        ctxMap.set(t, {
          hist_state: c?.hist_state,
          hist_z_ngr: c?.hist_z_ngr
        });
      }
    } catch (e) {
      console.error("[orderflow-map] context query failed:", e);
    }

    const out = {};
    for (const [ticker, agg] of aggMap.entries()) {
      if (!agg.total_vol || agg.total_vol <= 0 || !agg.open || !agg.close) continue;

      const hybrid = calculateHybridItem({
        ticker,
        open: agg.open,
        close: agg.close,
        total_vol: agg.total_vol,
        total_delta: agg.total_delta,
        high: agg.high,
        low: agg.low
      }, ctxMap.get(ticker) || {});

      if (!hybrid) continue;

      const netValue = hybrid.v && agg.close ? hybrid.v * agg.close : null;
      out[ticker] = {
        ticker,
        price: agg.close,
        delta_pct: hybrid.d,
        price_pct: hybrid.p,
        mom_pct: hybrid.p,
        absorb: hybrid.div,
        cvd: Number(agg.total_delta || 0),
        net_value: netValue,
        volume: hybrid.v,
        range: hybrid.r,
        score: hybrid.sc,
        signal: hybrid.sig,
        quadrant: mapQuadrant(hybrid.d, hybrid.p),
        context_state: hybrid.ctx_st,
        context_z: hybrid.ctx_net,
        snapshot_at: agg.last_ts ? new Date(agg.last_ts).toISOString() : new Date().toISOString(),
        generated_at: new Date().toISOString(),
        source: "d1"
      };
    }

    return out;
  } catch (err) {
    console.error("[orderflow-map] snapshot map failed:", err);
    return {};
  }
}

// ==============================
// Worker Entry
// ==============================
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // INTERNAL: Trigger audit & backfill daily broker flow
    if (url.pathname === "/internal/audit-backfill-daily" && req.method === "POST") {
      try {
        const logs = [];
        const triggerLimit = Number(url.searchParams.get("limit") || "40");
        const log = (msg) => { logs.push(msg); console.log(msg); };
        const result = await auditAndBackfillDailyBrokerFlow(env, {
          log,
          triggerLimit
        });
        return json({ ok: true, logs, result });
      } catch (e) {
        return json({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }
    try {
      console.log(`[API-SAHAM] Request: ${req.method} ${url.pathname} (v2026-02-04)`);

      // CORS
      if (req.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));

      if (url.pathname === "/admin/emiten/sync" && req.method === "POST") {
        const auth = requireIdxAdmin(req, env);
        if (!auth.ok) return auth.response;

        try {
          const result = await proxyIdxSync(env);
          return json(result.data, result.status);
        } catch (err) {
          console.error("[/admin/emiten/sync] Failed to trigger idx-handler", err);
          return json({ error: "IDX sync failed", details: err.message }, 502);
        }
      }

      // 0. GET /footprint/summary (Hybrid Bubble Chart - Static Live)
      if (url.pathname === "/footprint/summary" && req.method === "GET") {
        // WEEKEND FALLBACK: Check if today is weekend and fallback to last trading day's summary
        // WEEKEND FALLBACK (UTC): check weekend by UTC date string
        const now = new Date();
        const todayUTC = now.toISOString().slice(0, 10);
        const isWeekend = isWeekendUTC(todayUTC);


        let key = "features/footprint-summary.json";
        let object = await env.SSSAHAM_EMITEN.get(key);

        // Parse the existing object to check if it's empty
        let isEmpty = !object;
        let cachedData = null;
        if (object) {
          try {
            cachedData = await object.json();
            isEmpty = !cachedData.items || cachedData.items.length === 0;
          } catch (e) {
            isEmpty = true;
          }
        }

        const validation = cachedData?.validation || {};
        const withFootprint = Number(validation.with_footprint || validation.data_sources?.FULL || 0);
        const zscoreOnly = Number(validation.zscore_only || validation.data_sources?.ZSCORE || 0);
        const isZscoreOnlySummary = withFootprint === 0 && zscoreOnly > 0;
        const needsFallback = isEmpty || isWeekend || isZscoreOnlySummary;

        // If empty/weekend/zscore-only summary, search back up to 7 days for last FULL trading data.
        if (needsFallback) {
          const triggerReasons = [];
          if (isEmpty) triggerReasons.push("EMPTY");
          if (isWeekend) triggerReasons.push("WEEKEND");
          if (isZscoreOnlySummary) triggerReasons.push("ZSCORE_ONLY");
          console.log(`[SUMMARY] Fallback triggered: ${triggerReasons.join("+") || "UNKNOWN"} (todayUTC=${todayUTC}), searching DB for recent data...`);

          // Try up to 7 days back to find last trading day with data
          for (let daysBack = 1; daysBack <= 7; daysBack++) {
            const tryDate = new Date(now);
            tryDate.setDate(tryDate.getDate() - daysBack);
            const tryDay = tryDate.getDay();
            // Skip weekends
            if (tryDay === 0 || tryDay === 6) continue;

            const tryDateStr = tryDate.toISOString().split("T")[0];
            console.log(`[SUMMARY] Trying fallback date: ${tryDateStr} (${daysBack} days back)`);

            try {
              const rangeData = await calculateFootprintRange(env, tryDateStr, tryDateStr);
              if (rangeData && rangeData.items && rangeData.items.length > 0) {
                return json({
                  version: "v3.0-hybrid",
                  generated_at: new Date().toISOString(),
                  date: tryDateStr,
                  count: rangeData.items.length,
                  status: "FALLBACK",
                  reason: `Using ${tryDateStr} (${daysBack} day${daysBack > 1 ? 's' : ''} ago)`,
                  items: rangeData.items
                }, 200, { "Cache-Control": "public, max-age=300" }); // 5min cache for fallback
              }
            } catch (e) {
              console.error(`[SUMMARY] Fallback ${tryDateStr} failed:`, e.message);
            }
          }

          // Final fallback: return empty with message
          return json({
            version: "v3.0-hybrid",
            status: "NO_DATA",
            reason: isWeekend ? "WEEKEND_NO_DATA" : "NO_DATA",
            message: isWeekend ? "No trading data available for weekend. Market closed." : "No data available. No recent trading data found in last 7 days.",
            items: []
          }, 200);
        }

        // Normal case: return cached data
        const headers = new Headers();
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate"); // Force fresh on every request
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Content-Type", "application/json");

        return new Response(JSON.stringify(cachedData), { headers });
      }

      // 0.5 GET /footprint/range (Hybrid Bubble Chart - Date Range)
      if (url.pathname === "/footprint/range" && req.method === "GET") {
        const fromDate = url.searchParams.get("from");
        const toDate = url.searchParams.get("to");

        if (!fromDate || !toDate) return json({ error: "Missing from/to params" }, 400);

        try {
          const data = await calculateFootprintRange(env, fromDate, toDate);
          return json(data, 200, { "Cache-Control": "public, max-age=60" });
        } catch (e) {
          return json({ error: "Aggregation failed", details: e.message }, 500);
        }
      }

      // NEW: GET /footprint-raw-hist?kode=BBRI&date=2026-02-06
      // NEW: GET /footprint-raw-hist?kode=BBRI&date=2026-02-06
      if (url.pathname === "/footprint-raw-hist" && req.method === "GET") {
        const kode = url.searchParams.get("kode");
        const now = new Date();
        const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
        const todayWIBStr = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth() + 1).padStart(2, "0")}-${String(nowWIB.getDate()).padStart(2, "0")}`;

        let dateStr = url.searchParams.get("date") || todayWIBStr;
        if (!kode) return json({ error: "Missing kode" }, 400);

        // WEEKEND FALLBACK (UTC): If requested date is weekend, fallback to previous trading day
        if (isWeekendUTC(dateStr)) {
          const fallback = prevTradingDayUTC(dateStr);
          console.log(`[API] Weekend fallback (UTC): ${dateStr} -> ${fallback}`);
          dateStr = fallback;
        }

        try {
          const [y, m, d] = dateStr.split("-");

          // GENERATE KEYS FOR 00-23 UTC
          const hourKeys = [];
          for (let h = 0; h <= 23; h++) {
            const hStr = h.toString().padStart(2, "0");
            hourKeys.push({ h: hStr, key: `footprint/${kode}/1m/${y}/${m}/${d}/${hStr}.jsonl` });
          }

          console.log(`[API] Fetching all segments (00-23 UTC) for ${kode} @ ${dateStr}`);

          // PARALLEL FETCH
          const segments = await Promise.all(
            hourKeys.map(async ({ h, key }) => {
              const obj = await env.FOOTPRINT_BUCKET.get(key);
              if (!obj) {
                console.log(`[R2] MISSING: ${key}`);
                return [];
              }

              const text = await obj.text();
              console.log(`[R2] FOUND: ${key} (${text.length} bytes), first 100 chars: ${text.substring(0, 100)}`);

              const lines = text.split("\n").filter(l => l.trim());
              const candles = [];
              lines.forEach(line => {
                try { candles.push(JSON.parse(line)); } catch (e) {
                  console.error(`[API] JSON Parse Error in ${key}:`, e.message);
                }
              });
              return candles;
            })
          );

          const allCandles = segments.flat();

          // ========================================
          // THOUGHT PROCESS LOGGING (Smart Completion)
          // ========================================
          const now = new Date();
          const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
          const todayWIBStr = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth() + 1).padStart(2, "0")}-${String(nowWIB.getDate()).padStart(2, "0")}`;
          const dayOfWeek = nowWIB.getDay(); // 0=Sun, 6=Sat
          const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          const isToday = dateStr === todayWIBStr;
          const nowHour = nowWIB.getHours();
          const nowMin = nowWIB.getMinutes();

          console.log(`\n========== [THOUGHT PROCESS] ${kode} @ ${dateStr} ==========`);
          console.log(`[🕐 NOW] Today is ${todayWIBStr} (${dayNames[dayOfWeek]}), Time: ${nowHour}:${String(nowMin).padStart(2, "0")} WIB`);
          console.log(`[📅 CONTEXT] Today is ${isWeekend ? "WEEKEND" : "WEEKDAY"}`);
          console.log(`[📊 REQUEST] User requested data for: ${dateStr} (${isToday ? "TODAY" : "PAST DAY"})`);
          console.log(`[📁 R2 FETCH] Found ${allCandles.length} candles from ${hourKeys.length} hour segments`);

          // PHASE 3: Smart Completion Check
          const completion = checkDataCompleteness(allCandles, dateStr);
          const isIncomplete = completion.isIncomplete;

          // Show last candle info
          if (allCandles.length > 0) {
            const lastCandle = allCandles[allCandles.length - 1];
            const lastCandleWIB = new Date(new Date(lastCandle.t0).toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
            const lastH = lastCandleWIB.getHours();
            const lastM = lastCandleWIB.getMinutes();
            console.log(`[📈 CHART] Last candle at ${lastH}:${String(lastM).padStart(2, "0")} WIB`);
            if (!isToday) {
              console.log(`[📈 CHART] For past day, market close is 15:50 WIB. Last candle ${lastH > 15 || (lastH === 15 && lastM >= 50) ? "REACHES" : "DOES NOT REACH"} market close`);
            } else {
              console.log(`[📈 CHART] For today, expecting data up to ~${nowHour}:${String(nowMin).padStart(2, "0")} WIB`);
            }
          }

          // SKELETAL DETECTION
          let isBroken = false;
          if (allCandles.length > 0) {
            let sampled = 0;
            for (const c of allCandles) {
              if (c.vol > 0) {
                if (!c.levels || c.levels.length === 0) {
                  isBroken = true;
                  break;
                }
                sampled++;
                if (sampled >= 10) break;
              }
            }
          }

          console.log(`[🔍 DATA QUALITY] Skeletal/Broken: ${isBroken ? "YES ❌" : "NO ✅"}`);
          console.log(`[🔍 DATA QUALITY] Incomplete: ${isIncomplete ? `YES ❌ (${completion.reason})` : "NO ✅"}`);
          console.log(`[📊 TABLE] Expected: ${isToday ? "1 row per traded minute so far" : "~200-300 rows for full day"}. Actual: ${allCandles.length} rows`);
          console.log(`[📊 TABLE] Status: ${allCandles.length >= 20 || (isToday && allCandles.length >= 3) ? "LIKELY OK ✅" : "SPARSE ⚠️"}`);

          // ======================
          // DECISION (Repair gating) - MUST exist before repair trigger
          // ======================
          const missingSessionHours = await countMissingSessionHours(env, kode, dateStr);

          const decision = shouldRepairFootprint({
            candles: allCandles,
            dateStr,
            completion,
            missingSessionHours,
            brokenFound: isBroken
          });

          // For fallback gating: treat SPARSE as normal (don't fallback just because sparse)
          const treatAsIncomplete = completion.isIncomplete && completion.reason !== "SPARSE_DATA";


          // FALLBACK LOGIC
          let isFallback = false;
          let fallbackData = null;
          let fallbackLevel1Status = "NOT_CHECKED";
          let fallbackLevel2Status = "NOT_CHECKED";

          if (isBroken || allCandles.length === 0 || treatAsIncomplete) {
            console.log(`[🔄 FALLBACK] Triggering fallback due to: ${isBroken ? "BROKEN" : ""} ${allCandles.length === 0 ? "EMPTY" : ""} ${treatAsIncomplete ? `INCOMPLETE(${completion.reason})` : ""}`);

            // PRIORITY 1: processed/KODE/intraday.json
            const p1Key = `processed/${kode}/intraday.json`;
            const p1Obj = await env.SSSAHAM_EMITEN.get(p1Key);
            if (p1Obj) {
              fallbackData = await p1Obj.json();
              isFallback = true;
              fallbackLevel1Status = "FOUND ✅";
              console.log(`[🔄 FALLBACK] Level 1: ${p1Key} -> FOUND ✅`);
            } else {
              fallbackLevel1Status = "NOT_FOUND ❌";
              console.log(`[🔄 FALLBACK] Level 1: ${p1Key} -> NOT FOUND ❌`);

              // PRIORITY 2: FOOTPRINT_BUCKET processed/YYYY-MM-DD.json
              const p2Key = `processed/${dateStr}.json`;
              const p2Obj = await env.FOOTPRINT_BUCKET.get(p2Key);
              if (p2Obj) {
                const fullDaily = await p2Obj.json();
                const tickerData = (fullDaily.items || []).find(item => item.t === kode);
                if (tickerData) {
                  fallbackData = tickerData;
                  isFallback = true;
                  fallbackLevel2Status = "FOUND ✅";
                  console.log(`[🔄 FALLBACK] Level 2: ${p2Key} (ticker: ${kode}) -> FOUND ✅`);
                } else {
                  fallbackLevel2Status = "TICKER_NOT_IN_FILE ❌";
                  console.log(`[🔄 FALLBACK] Level 2: ${p2Key} exists but ${kode} not in items -> NOT FOUND ❌`);
                }
              } else {
                fallbackLevel2Status = "FILE_NOT_FOUND ❌";
                console.log(`[🔄 FALLBACK] Level 2: ${p2Key} -> NOT FOUND ❌`);
              }
            }
          } else {
            console.log(`[🔄 FALLBACK] Not needed - data is complete ✅`);
          }

          // REPAIR TRIGGER (Async) - Only for truly broken/incomplete, NOT sparse
          const repairAllowed = isRepairEnabled(env);
          const shouldTriggerRepair = repairAllowed && decision.repair && decision.reason !== "SPARSE_DATA";

          if (shouldTriggerRepair) {
            const repairUrl =
              `https://livetrade-taping-agregator.mkemalw.workers.dev/repair-footprint` +
              `?kode=${kode}&date=${dateStr}` +
              (decision.priority === "high" ? "&priority=high" : "");

            console.log(`[🔧 REPAIR] Triggering ${decision.priority.toUpperCase()} repair: ${repairUrl}`);

            if (ctx?.waitUntil) {
              ctx.waitUntil(fetch(repairUrl, { method: "POST" }).catch(e => console.error("[REPAIR] Trigger failed:", e.message)));
            } else {
              fetch(repairUrl, { method: "POST" }).catch(e => console.error("[REPAIR] Trigger failed:", e.message));
            }
          } else {
            if (!repairAllowed && decision.repair && decision.reason !== "SPARSE_DATA") {
              console.log(`[🔧 REPAIR] Skipped (REPAIR_ENABLED=false)`);
            } else {
              console.log(`[🔧 REPAIR] Not needed${decision.reason === "SPARSE_DATA" ? " (sparse stock, not broken)" : ""}`);
            }
          }

          // is_repairing should be false for SPARSE_DATA or when kill switch is off
          const isRepairing = shouldTriggerRepair;
          console.log(`[📤 RESPONSE] is_fallback: ${isFallback}, is_repairing: ${isRepairing}`);
          console.log(`========== [END THOUGHT PROCESS] ==========\n`);

          if (allCandles.length === 0 && !isFallback) {
            return json({ status: "OK", buckets: [], history: [], candles: [], is_repairing: shouldTriggerRepair });
          }

          // RESOLUTION: 1-minute (direct from R2) to ensure alignment for sparse data
          allCandles.sort((a, b) => a.t0 - b.t0);

          const history = [];
          const tableData = [];
          const candles = [];

          // If fallback is found, map its timeline to our result
          const fallbackTimelineMap = new Map();
          if (isFallback && fallbackData && Array.isArray(fallbackData.timeline)) {
            for (const entry of fallbackData.timeline) {
              if (!entry || typeof entry.t !== "string") continue;
              fallbackTimelineMap.set(entry.t.trim(), entry);
            }
          }


          allCandles.forEach(c => {
            const dateObj = new Date(c.t0);
            const timeStr = dateObj.toLocaleTimeString("en-GB", {
              hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta"
            });

            // Chart candle
            const { open, high, low, close } = resolveOHLC(c);
            const pricePct = open > 0 ? ((close - open) / open) * 100 : 0;
            const absCvd = c.vol > 0 ? (Math.abs(c.delta / c.vol) * 100) / (1 + Math.abs(pricePct)) : 0;

            candles.push({ x: c.t0, o: open, h: high, l: low, c: close });

            // Table Summary (1 row per minute)
            tableData.push({
              t: timeStr,
              x: c.t0,
              p: close,
              v: c.vol,
              a: c.delta,
              m: c.vol > 0 ? Number(((c.delta / c.vol) * 50 + 50).toFixed(2)) : 50, // Haka/Haki balance
              abs: Number(absCvd.toFixed(2))
            });

            // Table buckets / bubbles (Granular)
            if (c.levels && c.levels.length > 0) {
              c.levels.forEach(lvl => {
                const totalV = lvl.bv + lvl.av;
                if (totalV > 0) {
                  history.push({
                    t: timeStr,
                    x: c.t0,
                    p: lvl.p,
                    v: totalV,
                    bv: lvl.bv,
                    av: lvl.av,
                    side: lvl.bv >= lvl.av ? "buy" : "sell"
                  });
                }
              });
            } else if (isFallback && (c.vol || 0) > 0 && fallbackTimelineMap.has(timeStr)) {              // Inject fallback bubble for this minute
              const f = fallbackTimelineMap.get(timeStr);
              history.push({
                t: timeStr,
                x: c.t0,
                p: f.p,
                v: f.v,
                m: f.m,
                a: f.a,
                is_fallback: true,
                side: f.a >= 0 ? "buy" : "sell"
              });
            } else if (c.vol > 0) {
              // Synthetic bubble when no levels exist (keeps sparse trades visible)
              history.push({
                t: timeStr,
                x: c.t0,
                p: close,
                v: c.vol,
                bv: c.delta > 0 ? (c.vol + c.delta) / 2 : c.vol / 2,
                av: c.delta < 0 ? (c.vol - c.delta) / 2 : c.vol / 2,
                side: c.delta >= 0 ? "buy" : "sell",
                is_synthetic: true
              });
            }
          });

          return json({
            status: "OK",
            buckets: history,
            tableData: tableData,
            candles,
            is_repairing: isRepairing,
            is_fallback: isFallback
          });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }


      // NEW: GET /symbol?kode=BBRI&mode=footprint
      if (url.pathname === "/symbol" && req.method === "GET") {
        const kode = url.searchParams.get("kode");
        if (!kode) return json({ error: "Missing kode" }, 400);

        try {
          // 1. Determine Date (Last trading day or Today)
          const latestRow = await env.SSSAHAM_DB.prepare(
            "SELECT MAX(date) as last_date FROM temp_footprint_consolidate WHERE ticker = ?"
          ).bind(kode).first();

          let dateStr = latestRow?.last_date || new Date().toISOString().slice(0, 10);

          // If the resolved date is weekend in UTC, roll back to previous trading day
          if (isWeekendUTC(dateStr)) {
            const fallback = prevTradingDayUTC(dateStr);
            console.log(`[SYMBOL] Weekend fallback (UTC): ${dateStr} -> ${fallback}`);
            dateStr = fallback;
          }

          const [y, m, d] = dateStr.split("-");

          // 2. Fetch Granular Footprint from R2 (00-23 UTC)
          const hourKeys = [];
          for (let h = 0; h <= 23; h++) {
            const hStr = h.toString().padStart(2, "0");
            hourKeys.push(`footprint/${kode}/1m/${y}/${m}/${d}/${hStr}.jsonl`);
          }

          const segments = await Promise.all(
            hourKeys.map(async (key) => {
              const obj = await env.FOOTPRINT_BUCKET.get(key);
              if (!obj) return [];
              const text = await obj.text();
              const lines = text.split("\n").filter(l => l.trim());
              const candles = [];
              lines.forEach(line => {
                try { candles.push(JSON.parse(line)); } catch (e) { }
              });
              return candles;
            })
          );
          const allCandles = segments.flat();

          // PHASE 3: Smart Completion Check
          const completion = checkDataCompleteness(allCandles, dateStr);
          const isIncomplete = completion.isIncomplete;

          // SKELETAL DETECTION
          let isBroken = false;
          if (allCandles.length > 0) {
            let sampled = 0;
            for (const c of allCandles) {
              if (c.vol > 0) {
                if (!c.levels || c.levels.length === 0) {
                  isBroken = true;
                  break;
                }
                sampled++;
                if (sampled >= 10) break;
              }
            }
          }

          // ======================
          // DECISION (Repair gating) - MUST exist before fallback/repair trigger
          // ======================

          // For fallback gating: treat SPARSE as normal (don't fallback just because sparse)
          const treatAsIncomplete = completion.isIncomplete && completion.reason !== "SPARSE_DATA";

          // Missing-session heuristic is only meaningful when PAST DAY / non-sparse / broken-ish.
          // (avoid extra R2 HEAD calls when data looks normal)
          let missingSessionHours = 0;
          if (allCandles.length === 0 || isBroken || treatAsIncomplete) {
            missingSessionHours = await countMissingSessionHours(env, kode, dateStr);
          }

          const decision = shouldRepairFootprint({
            candles: allCandles,
            dateStr,
            completion,
            missingSessionHours,
            brokenFound: isBroken
          });


          // FALLBACK LOGIC

          // ======================
          // SOURCE SELECTION (P0 -> P2)
          // P0: Raw R2 segments (00-23 UTC) -> allCandles
          // P1: SSSAHAM_EMITEN `processed/${kode}/intraday.json`
          // P2: FOOTPRINT_BUCKET `processed/${dateStr}.json` (pick ticker)
          // ======================

          // For fallback gating: treat SPARSE as normal (don't fallback just because sparse)

          let isFallback = false;
          let fallbackFrom = null; // "p1" | "p2" | null
          let fallbackData = null;
          let fallbackLevel1Status = "NOT_CHECKED";
          let fallbackLevel2Status = "NOT_CHECKED";

          const needFallback = isBroken || allCandles.length === 0 || treatAsIncomplete;

          // ---- P0 status log
          console.log(
            `[SOURCE] P0 raw: candles=${allCandles.length}, broken=${isBroken ? "YES" : "NO"}, incomplete=${isIncomplete ? `YES(${completion.reason})` : "NO"}`
          );

          // ---- P1 then P2
          if (needFallback) {
            console.log(`[SOURCE] P0 unusable -> try P1 then P2`);

            // P1: processed/KODE/intraday.json
            const p1Key = `processed/${kode}/intraday.json`;
            const p1Obj = await env.SSSAHAM_EMITEN.get(p1Key);

            if (p1Obj) {
              try {
                fallbackData = await p1Obj.json();
                isFallback = true;
                fallbackFrom = "p1";
                fallbackLevel1Status = "FOUND ✅";
                console.log(`[SOURCE] P1 FOUND ✅ -> ${p1Key}`);
              } catch (e) {
                fallbackLevel1Status = `PARSE_ERROR ❌ (${e.message})`;
                console.error(`[SOURCE] P1 parse error:`, e.message);
              }
            } else {
              fallbackLevel1Status = "NOT_FOUND ❌";
              console.log(`[SOURCE] P1 NOT FOUND ❌ -> ${p1Key}`);
            }

            // P2: processed/YYYY-MM-DD.json (ticker slice)
            if (!isFallback) {
              const p2Key = `processed/${dateStr}.json`;
              const p2Obj = await env.FOOTPRINT_BUCKET.get(p2Key);

              if (p2Obj) {
                try {
                  const fullDaily = await p2Obj.json();
                  const tickerData = (fullDaily.items || []).find(item => item.t === kode);

                  if (tickerData) {
                    fallbackData = tickerData;
                    isFallback = true;
                    fallbackFrom = "p2";
                    fallbackLevel2Status = "FOUND ✅";
                    console.log(`[SOURCE] P2 FOUND ✅ -> ${p2Key} (ticker ${kode})`);
                  } else {
                    fallbackLevel2Status = "TICKER_NOT_IN_FILE ❌";
                    console.log(`[SOURCE] P2 exists but ${kode} not in items ❌ -> ${p2Key}`);
                  }
                } catch (e) {
                  fallbackLevel2Status = `PARSE_ERROR ❌ (${e.message})`;
                  console.error(`[SOURCE] P2 parse error:`, e.message);
                }
              } else {
                fallbackLevel2Status = "FILE_NOT_FOUND ❌";
                console.log(`[SOURCE] P2 NOT FOUND ❌ -> ${p2Key}`);
              }
            }
          } else {
            console.log(`[SOURCE] P0 OK ✅ (no fallback)`);
          }

          // ======================
          // REPAIR TRIGGER (Async) - Only for truly broken/incomplete, NOT sparse
          // ======================
          const repairAllowed = isRepairEnabled(env);
          const shouldTriggerRepair = repairAllowed && decision.repair && decision.reason !== "SPARSE_DATA";

          if (shouldTriggerRepair) {
            const repairUrl =
              `https://livetrade-taping-agregator.mkemalw.workers.dev/repair-footprint` +
              `?kode=${kode}&date=${dateStr}` +
              (decision.priority === "high" ? "&priority=high" : "");

            console.log(`[🔧 REPAIR] Triggering ${decision.priority.toUpperCase()} repair: ${repairUrl}`);

            if (ctx?.waitUntil) {
              ctx.waitUntil(fetch(repairUrl, { method: "POST" }).catch(e => console.error("[REPAIR] Trigger failed:", e.message)));
            } else {
              fetch(repairUrl, { method: "POST" }).catch(e => console.error("[REPAIR] Trigger failed:", e.message));
            }
          } else {
            if (!repairAllowed && decision.repair && decision.reason !== "SPARSE_DATA") {
              console.log(`[🔧 REPAIR] Skipped (REPAIR_ENABLED=false)`);
            } else {
              console.log(`[🔧 REPAIR] Not needed${decision.reason === "SPARSE_DATA" ? " (sparse stock, not broken)" : ""}`);
            }
          }

          // is_repairing should be false for SPARSE_DATA or when kill switch is off
          const isRepairing = shouldTriggerRepair;

          console.log(`[📤 RESPONSE] source=${isFallback ? (fallbackFrom || "fallback") : "p0"}, is_fallback=${isFallback}, is_repairing=${isRepairing}`);
          console.log(`[📤 RESPONSE] p1=${fallbackLevel1Status}, p2=${fallbackLevel2Status}`);
          console.log(`========== [END THOUGHT PROCESS] ==========\n`);

          // ======================
          // EMPTY P0 HANDLING:
          // If P0 empty BUT P1/P2 has timeline -> return fallback-only chart immediately
          // ======================
          if (allCandles.length === 0) {
            if (isFallback && fallbackData && Array.isArray(fallbackData.timeline) && fallbackData.timeline.length > 0) {
              const fb = buildFromFallbackTimeline(kode, dateStr, fallbackData);

              return json({
                status: "OK",
                buckets: fb.buckets,
                tableData: fb.tableData,
                candles: fb.candles,
                is_repairing: isRepairing,
                is_fallback: true
              });
            }

            // No raw + no usable fallback -> return empty but signal repairing
            return json({
              status: "OK",
              buckets: [],
              tableData: [],
              candles: [],
              is_repairing: isRepairing,
              is_fallback: false
            });
          }


          // 3. Aggregate 1m -> 5m buckets
          allCandles.sort((a, b) => a.t0 - b.t0);
          // PATCH D: build fallback timeline map once (avoid O(n^2) find per candle)
          const fallbackTimelineMap = new Map();
          if (isFallback && fallbackData && Array.isArray(fallbackData.timeline)) {
            for (const entry of fallbackData.timeline) {
              if (!entry || typeof entry.t !== "string") continue;
              fallbackTimelineMap.set(entry.t.trim(), entry); // key: "HH:MM"
            }
          }

          const buckets = new Map(); // timeKey5m -> { t0, levels: Map<p, {bv, av}>, o, h, l, c, vol, delta }

          allCandles.forEach(c => {
            const t0_5m = Math.floor(c.t0 / 300000) * 300000;
            const { open, high, low, close } = resolveOHLC(c);
            if (!buckets.has(t0_5m)) {
              buckets.set(t0_5m, {
                t0: t0_5m,
                levels: new Map(),
                o: open, h: high, l: low, c: close,
                vol: 0, delta: 0
              });
            }
            const b = buckets.get(t0_5m);
            b.h = Math.max(b.h, high);
            b.l = Math.min(b.l, low);
            b.c = close;
            b.vol += c.vol;
            b.delta += c.delta;

            if (c.levels && c.levels.length > 0) {
              c.levels.forEach(lvl => {
                if (!b.levels.has(lvl.p)) b.levels.set(lvl.p, { p: lvl.p, bv: 0, av: 0 });
                const bl = b.levels.get(lvl.p);
                bl.bv += lvl.bv;
                bl.av += lvl.av;
              });
            } else if (fallbackTimelineMap.size > 0 && (c.vol || 0) > 0) {
              // PATCH D: O(1) lookup by "HH:MM"
              const dateObj = new Date(c.t0);
              const timeStr = dateObj.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Asia/Jakarta"
              });

              const f = fallbackTimelineMap.get(timeStr);
              if (f) {
                if (!b.levels.has(f.p)) b.levels.set(f.p, { p: f.p, bv: 0, av: 0, is_fallback: true });
                const bl = b.levels.get(f.p);

                const bv = (f.v + f.a) / 2;
                const av = f.v - bv;

                bl.bv += bv;
                bl.av += av;
              }
            }


          });

          // 4. Final Data Prep for Frontend
          const history = []; // Bubbles: { t, p, v, bv, av, side }
          const candles = []; // Candlesticks: { x, o, h, l, c }

          const sortedBuckets = Array.from(buckets.values()).sort((a, b) => a.t0 - b.t0);

          sortedBuckets.forEach(b => {
            const timeStr = new Date(b.t0).toLocaleTimeString('en-GB', {
              hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
            });

            // Add Candle
            candles.push({
              x: b.t0,
              o: b.o,
              h: b.h,
              l: b.l,
              c: b.c
            });

            // Add Bubbles at Price Levels
            b.levels.forEach(lvl => {
              const totalV = lvl.bv + lvl.av;
              if (totalV > 0) {
                history.push({
                  t: timeStr,
                  x: b.t0, // Link bubble to candle timestamp
                  p: lvl.p,
                  v: totalV,
                  bv: lvl.bv,
                  av: lvl.av,
                  side: lvl.bv >= lvl.av ? 'buy' : 'sell'
                });
              }
            });
          });

          // 5. Snapshot Stats (Lightweight)
          // Just get basic stats from D1 for the snapshot
          const lastHist = await env.SSSAHAM_DB.prepare(
            "SELECT * FROM temp_footprint_consolidate WHERE ticker = ? AND date = ? ORDER BY time_key DESC LIMIT 1"
          ).bind(kode, dateStr).first();

          const dayStats = await env.SSSAHAM_DB.prepare(
            "SELECT MIN(low) as low, MAX(high) as high, SUM(vol) as vol, SUM(delta) as net_vol, " +
            "(SELECT open FROM temp_footprint_consolidate WHERE ticker = ? AND date = ? ORDER BY time_key ASC LIMIT 1) as open " +
            "FROM temp_footprint_consolidate WHERE ticker = ? AND date = ?"
          ).bind(kode, dateStr, kode, dateStr).first();

          const snapshot = {
            ticker: kode,
            date: dateStr,
            close: lastHist?.close || 0,
            open: dayStats?.open || 0,
            high: dayStats?.high || 0,
            low: dayStats?.low || 0,
            vol: dayStats?.vol || 0,
            net_vol: dayStats?.net_vol || 0,
            haka_pct: dayStats ? parseFloat((((dayStats.net_vol / dayStats.vol) * 100 + 100) / 2).toFixed(1)) : 50,
            fluktuasi: (dayStats && dayStats.open > 0) ? parseFloat((((lastHist.close - dayStats.open) / dayStats.open) * 100).toFixed(2)) : 0,
            history: [] // Limited history or empty, chart uses /footprint-raw-hist
          };

          const stateRow = await env.SSSAHAM_DB.prepare(`
            SELECT state as quadrant_st, score
            FROM daily_features
            WHERE ticker = ? 
            ORDER BY date DESC LIMIT 1
          `).bind(kode).first();

          return json({
            snapshot,
            state: stateRow ? {
              quadrant: stateRow.quadrant_st === 'ACCUMULATION' ? 1 : (stateRow.quadrant_st === 'DISTRIBUTION' ? 3 : 2),
              score: stateRow.score
            } : null,
            // is_repairing should reflect actual repair trigger state
            is_repairing: isRepairing,
            is_fallback: isFallback
          });

        } catch (e) {
          return json({ error: "Fetch symbol (R2) failed", details: e.message }, 500);
        }
      }

      // 1. GET /screener
      if (url.pathname === "/screener" && req.method === "GET") {
        try {
          // Fetch Pointer
          const pointerObj = await env.SSSAHAM_EMITEN.get("features/latest.json");
          if (!pointerObj) return json({ items: [] });

          let data = await pointerObj.json();

          // Check if it is a pointer (has pointer_to)
          if (data.pointer_to) {
            const actualObj = await env.SSSAHAM_EMITEN.get(data.pointer_to);
            if (!actualObj) return json({ items: [] });
            data = await actualObj.json();
          }

          return withCORS(new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch screener", details: e.message }, 500);
        }
      }

      // GET /foreign-flow-scanner - Returns pre-computed foreign flow trend data
      if (url.pathname === "/foreign-flow-scanner" && req.method === "GET") {
        try {
          const obj = await env.SSSAHAM_EMITEN.get("features/foreign-flow-scanner.json");
          if (!obj) return json({ items: [], error: "No data. Run /foreign-flow-scanner on features-service first." });
          const data = await obj.json();
          return withCORS(new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch foreign flow scanner", details: e.message }, 500);
        }
      }

      // GET /screener-mvp - Returns screener filtered by last 2 days foreign+local positive
      if (url.pathname === "/screener-mvp" && req.method === "GET") {
        try {
          const CACHE_VERSION = 'v2'; // Bump to invalidate cache
          const CACHE_TTL_SECONDS = 3600; // 1 hour
          const FOREIGN_CODES = new Set(['ZP', 'YU', 'KZ', 'RX', 'BK', 'AK', 'CS', 'CG', 'DB', 'ML', 'CC', 'DX', 'FS', 'LG', 'NI', 'OD']);

          // Check cache first
          const cacheKey = `cache/screener-mvp-${CACHE_VERSION}.json`;
          const cachedObj = await env.SSSAHAM_EMITEN.get(cacheKey);

          if (cachedObj) {
            const cached = await cachedObj.json();
            const cacheAge = (Date.now() - (cached.timestamp || 0)) / 1000;
            if (cacheAge < CACHE_TTL_SECONDS) {
              return withCORS(new Response(JSON.stringify({
                ...cached.data,
                cached: true,
                cacheAge: Math.round(cacheAge)
              }), { headers: { "Content-Type": "application/json" } }));
            }
          }

          // Fetch screener data
          const pointerObj = await env.SSSAHAM_EMITEN.get("features/latest.json");
          if (!pointerObj) return json({ items: [] });
          let screenerData = await pointerObj.json();
          if (screenerData.pointer_to) {
            const actualObj = await env.SSSAHAM_EMITEN.get(screenerData.pointer_to);
            if (!actualObj) return json({ items: [] });
            screenerData = await actualObj.json();
          }

          // Get last 2 trading days (skip today as data may be incomplete)
          const dates = [];
          const today = new Date();
          for (let i = 1; i < 10 && dates.length < 2; i++) { // Start from yesterday (i=1)
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) {
              dates.push(d.toISOString().split('T')[0]);
            }
          }

          // Filter stocks by last 2 days foreign+local positive
          const filteredItems = [];
          const brokersMap = {};

          // Fetch brokers mapping
          try {
            const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
            if (results) results.forEach(b => brokersMap[b.code] = b);
          } catch (e) { }

          const isRetail = (code) => {
            const b = brokersMap[code];
            if (!b) return false;
            return (b.category || '').toLowerCase().includes('retail');
          };

          for (const item of screenerData.items || []) {
            const ticker = item.t;
            let passFilter = true;
            let flowData = { day1: null, day2: null };

            for (let dayIdx = 0; dayIdx < dates.length && passFilter; dayIdx++) {
              const dateStr = dates[dayIdx];
              try {
                const key = `${ticker}/${dateStr}.json`;
                const obj = await env.RAW_BROKSUM.get(key);
                if (!obj) { passFilter = false; continue; }

                const fileData = await obj.json();
                const bs = fileData?.data?.broker_summary;
                if (!bs) { passFilter = false; continue; }

                let foreignBuy = 0, foreignSell = 0;
                let localBuy = 0, localSell = 0;

                if (bs.brokers_buy && Array.isArray(bs.brokers_buy)) {
                  bs.brokers_buy.forEach(b => {
                    if (!b) return;
                    const val = parseFloat(b.bval) || 0;
                    const code = b.netbs_broker_code;
                    if (b.type === 'Asing' || FOREIGN_CODES.has(code)) foreignBuy += val;
                    else if (!isRetail(code)) localBuy += val;
                  });
                }

                if (bs.brokers_sell && Array.isArray(bs.brokers_sell)) {
                  bs.brokers_sell.forEach(b => {
                    if (!b) return;
                    const val = parseFloat(b.sval) || 0;
                    const code = b.netbs_broker_code;
                    if (b.type === 'Asing' || FOREIGN_CODES.has(code)) foreignSell += val;
                    else if (!isRetail(code)) localSell += val;
                  });
                }

                const foreignNet = foreignBuy - foreignSell;
                const localNet = localBuy - localSell;

                // Filter: foreign AND local must be positive (smart money inflow)
                if (foreignNet <= 0 || localNet <= 0) {
                  passFilter = false;
                }

                if (dayIdx === 0) flowData.day1 = { foreign: foreignNet, local: localNet, date: dateStr };
                else flowData.day2 = { foreign: foreignNet, local: localNet, date: dateStr };

              } catch (e) {
                passFilter = false;
              }
            }

            if (passFilter && flowData.day1 && flowData.day2) {
              filteredItems.push({
                ...item,
                flow: flowData
              });
            }
          }

          const responseData = {
            items: filteredItems,
            date: screenerData.date,
            filter: 'foreign+local > 0 last 2 days',
            total: filteredItems.length
          };

          // Store in cache
          try {
            await env.SSSAHAM_EMITEN.put(cacheKey, JSON.stringify({
              timestamp: Date.now(),
              data: responseData
            }));
          } catch (e) { }

          return withCORS(new Response(JSON.stringify({
            ...responseData,
            cached: false
          }), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch screener-mvp", details: e.message }, 500);
        }
      }

      // GET /screener-accum - Returns pre-aggregated accumulation scanner data
      // Artifact built by accum-preprocessor cron in broksum-scrapper
      // Supports ?window=2|5|10|20 (default: 2) for server-side pre-filter
      if (url.pathname === "/screener-accum" && req.method === "GET") {
        try {
          const cacheKey = "cache/screener-accum-latest.json";
          const obj = await env.SSSAHAM_EMITEN.get(cacheKey);
          if (!obj) {
            return json({ items: [], error: "Accumulation data not yet generated. Cron runs at 19:15 WIB." });
          }

          const accumData = await obj.json();
          const validWindows = [2, 5, 10, 20];

          // Merge with screener z-score data for enriched response
          let screenerMap = {};
          try {
            const pointerObj = await env.SSSAHAM_EMITEN.get("features/latest.json");
            if (pointerObj) {
              let screenerData = await pointerObj.json();
              if (screenerData.pointer_to) {
                const actualObj = await env.SSSAHAM_EMITEN.get(screenerData.pointer_to);
                if (actualObj) screenerData = await actualObj.json();
              }
              for (const item of (screenerData.items || [])) {
                screenerMap[item.t] = item;
              }
            }
          } catch (e) {
            console.error("[screener-accum] Failed to load z-score data:", e);
          }

          // Optional: attach live orderflow snapshot map (today)
          let orderflowMap = {};
          try {
            orderflowMap = await getOrderflowSnapshotMap(env);
          } catch (e) {
            console.error("[screener-accum] Failed to load orderflow map:", e);
          }

          // Build enriched items: ALL windows per ticker + z-score data
          const items = [];
          for (const row of (accumData.items || [])) {
            if (!row.accum) continue;
            const screenerItem = screenerMap[row.t] || null;

            items.push({
              t: row.t,
              // All window accum data
              accum: row.accum,
              coverage: row.coverage || null,
              // Z-score data (if available)
              s: screenerItem?.s || null,
              sc: screenerItem?.sc || null,
              z: screenerItem?.z || null,
              // Live orderflow snapshot for scanner/list integration
              orderflow: orderflowMap[row.t] || null
            });
          }

          return withCORS(new Response(JSON.stringify({
            items,
            date: accumData.date,
            generatedAt: accumData.generated_at,
            windows: validWindows,
            total: items.length
          }), { headers: { "Content-Type": "application/json" } }));

        } catch (e) {
          return json({ error: "Failed to fetch screener-accum", details: e.message }, 500);
        }
      }

      // GET /foreign-sentiment - Returns foreign gross flow for MVP 10 stocks
      // Cached in R2 with 1 hour TTL
      if (url.pathname === "/foreign-sentiment" && req.method === "GET") {
        try {
          const CACHE_VERSION = 'v2'; // Bump this when logic changes
          const CACHE_TTL_SECONDS = 3600; // 1 hour
          const MVP_TICKERS = ['BREN', 'BBCA', 'DSSA', 'BBRI', 'TPIA', 'AMMN', 'BYAN', 'DCII', 'BMRI', 'TLKM'];
          const FOREIGN_CODES = new Set(['ZP', 'YU', 'KZ', 'RX', 'BK', 'AK', 'CS', 'CG', 'DB', 'ML', 'CC', 'DX', 'FS', 'LG', 'NI', 'OD']);
          const days = Math.min(parseInt(url.searchParams.get('days') || '7'), 90); // Max 90 days
          const fresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('fresh') || '').toLowerCase());

          // Check cache first
          const cacheKey = `cache/foreign-sentiment-${days}d-${CACHE_VERSION}.json`;
          const cachedObj = await env.SSSAHAM_EMITEN.get(cacheKey);

          if (cachedObj && !fresh) {
            const cached = await cachedObj.json();
            const cacheAge = (Date.now() - (cached.timestamp || 0)) / 1000;

            if (cacheAge < CACHE_TTL_SECONDS) {
              // Return cached data
              return withCORS(new Response(JSON.stringify({
                ...cached.data,
                cached: true,
                cacheAge: Math.round(cacheAge)
              }), { headers: { "Content-Type": "application/json" } }));
            }
          }

          // Generate date list (trading days only)
          const dates = [];
          const today = new Date();
          for (let i = 0; i < days + Math.ceil(days * 0.5); i++) { // Extra buffer for weekends
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) { // Skip weekends
              dates.push(d.toISOString().split('T')[0]);
            }
            if (dates.length >= days) break;
          }

          const result = {};
          const incompleteByDate = {};
          const repairTickers = new Set();

          // Fetch data for each ticker
          for (const ticker of MVP_TICKERS) {
            const tickerData = [];

            for (const dateStr of dates) {
              try {
                const key = `${ticker}/${dateStr}.json`;
                const obj = await env.RAW_BROKSUM.get(key);
                if (!obj) continue;

                const fileData = await obj.json();
                const bs = fileData?.data?.broker_summary;
                if (!bs) continue;

                const brokerBuyRows = Array.isArray(bs.brokers_buy) ? bs.brokers_buy : [];
                const brokerSellRows = Array.isArray(bs.brokers_sell) ? bs.brokers_sell : [];
                const hasBrokerRows = brokerBuyRows.length > 0 || brokerSellRows.length > 0;
                const grossValue = parseFloat(bs?.stock_summary?.total_value) || 0;

                // Guardrail: active market day with empty broker rows is incomplete,
                // not a valid 0 foreign-flow day.
                if (!hasBrokerRows && grossValue > 0) {
                  tickerData.push({
                    date: dateStr,
                    buy: null,
                    sell: null,
                    net: null,
                    incomplete: true
                  });
                  if (!incompleteByDate[dateStr]) incompleteByDate[dateStr] = [];
                  incompleteByDate[dateStr].push(ticker);
                  repairTickers.add(ticker);
                  continue;
                }

                let foreignBuy = 0, foreignSell = 0;

                // Process buyers
                if (brokerBuyRows.length) {
                  brokerBuyRows.forEach(b => {
                    if (b && (b.type === 'Asing' || FOREIGN_CODES.has(b.netbs_broker_code))) {
                      foreignBuy += parseFloat(b.bval) || 0;
                    }
                  });
                }

                // Process sellers
                if (brokerSellRows.length) {
                  brokerSellRows.forEach(b => {
                    if (b && (b.type === 'Asing' || FOREIGN_CODES.has(b.netbs_broker_code))) {
                      foreignSell += parseFloat(b.sval) || 0;
                    }
                  });
                }

                tickerData.push({
                  date: dateStr,
                  buy: foreignBuy,
                  sell: foreignSell,
                  net: foreignBuy - foreignSell
                });
              } catch (e) {
                // Skip missing data
              }
            }

            // Sort by date ascending
            tickerData.sort((a, b) => a.date.localeCompare(b.date));
            result[ticker] = tickerData;
          }

          // Calculate cumulative total across all tickers per day
          const sortedDates = dates.sort();
          const cumulative = sortedDates.map(dateStr => {
            let totalBuy = 0, totalSell = 0;
            let hasAnyValue = false;
            let incompleteTickers = 0;
            for (const ticker of MVP_TICKERS) {
              const tickerData = result[ticker] || [];
              const day = tickerData.find(d => d.date === dateStr);
              if (day) {
                if (typeof day.buy === 'number' && typeof day.sell === 'number') {
                  totalBuy += day.buy;
                  totalSell += day.sell;
                  hasAnyValue = true;
                } else if (day.incomplete) {
                  incompleteTickers += 1;
                }
              }
            }
            return {
              date: dateStr,
              buy: hasAnyValue ? totalBuy : null,
              sell: hasAnyValue ? totalSell : null,
              net: hasAnyValue ? (totalBuy - totalSell) : null,
              incomplete_tickers: incompleteTickers
            };
          });

          // Trigger async repair for incomplete symbols (best effort).
          if (repairTickers.size > 0 && env.BROKSUM_SERVICE) {
            const jobs = Array.from(repairTickers).map(symbol =>
              env.BROKSUM_SERVICE.fetch(
                `http://internal/auto-backfill?symbol=${encodeURIComponent(symbol)}&days=5&force=true`
              ).catch(() => null)
            );
            ctx.waitUntil(Promise.allSettled(jobs));
          }

          const responseData = {
            tickers: MVP_TICKERS,
            data: result,
            cumulative: cumulative,
            dates: sortedDates,
            incomplete_dates: incompleteByDate
          };

          // Store in cache (await to ensure it completes)
          try {
            await env.SSSAHAM_EMITEN.put(cacheKey, JSON.stringify({
              timestamp: Date.now(),
              data: responseData
            }));
          } catch (cacheErr) {
            console.error('Cache write failed:', cacheErr);
          }

          return withCORS(new Response(JSON.stringify({
            ...responseData,
            cached: false
          }), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch foreign sentiment", details: e.message }, 500);
        }
      }

      // 1.6 GET /audit/logs - Get scraping logs from D1
      if (url.pathname === "/audit/logs" && req.method === "GET") {
        try {
          const limit = parseInt(url.searchParams.get("limit") || "100");

          if (!env.SSSAHAM_DB) {
            return json({ error: "DB binding missing" }, 500);
          }

          const { results } = await env.SSSAHAM_DB.prepare(
            `SELECT * FROM scraping_logs ORDER BY timestamp DESC LIMIT ?`
          ).bind(limit).all();

          return withCORS(new Response(JSON.stringify(results || []), {
            headers: { "Content-Type": "application/json" }
          }));
        } catch (e) {
          return json({ error: "Failed to fetch logs", details: e.message }, 500);
        }
      }

      // 2. GET /features/history (Per Emiten Z-Score Audit Trail)
      if (url.pathname === "/features/history" && req.method === "GET") {
        const ticker = url.searchParams.get("symbol");
        if (!ticker) return json({ error: "Missing symbol" }, 400);

        try {
          const key = `features/z_score/emiten/${ticker}.json`;
          const obj = await env.SSSAHAM_EMITEN.get(key);
          if (!obj) return json({ error: "No history found" }, 404);
          return withCORS(new Response(obj.body, { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Fetch error", details: e.message }, 500);
        }
      }

      // 2b. GET /features/calculate (On-Demand Z-Score Calculation)
      if (url.pathname === "/features/calculate" && req.method === "GET") {
        const ticker = url.searchParams.get("symbol");
        if (!ticker) return json({ error: "Missing symbol" }, 400);

        try {
          // Strategy 1: Check if data exists in R2 cache (from broker-summary)
          const cacheKey = `broksum/${ticker}/cache.json`;
          const cacheObj = await env.RAW_BROKSUM.get(cacheKey);

          let days = [];

          if (cacheObj) {
            // Use broker summary cache data
            const cacheData = await cacheObj.json();
            if (cacheData.history && cacheData.history.length >= 5) {
              days = cacheData.history.map(h => ({
                date: h.date,
                total_vol: h.data?.detector?.volume || 0,
                total_delta: (h.data?.foreign?.net_val || 0) + (h.data?.local?.net_val || 0), // Smart money flow
                close: h.data?.price || h.data?.detector?.average || 0
              })).filter(d => d.close > 0);
            }
          }

          // Strategy 2: Fallback to D1 footprint data
          if (days.length < 5) {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);
            const startDateStr = startDate.toISOString().split("T")[0];

            const { results } = await env.SSSAHAM_DB.prepare(`
              SELECT date, 
                     SUM(vol) as total_vol, 
                     SUM(delta) as total_delta,
                     MAX(close) as close
              FROM temp_footprint_consolidate
              WHERE ticker = ? AND date >= ?
              GROUP BY date
              ORDER BY date DESC
              LIMIT 20
            `).bind(ticker, startDateStr).all();

            if (results && results.length > days.length) {
              days = results;
            }
          }

          if (days.length < 5) {
            return json({
              symbol: ticker,
              source: "none",
              message: "Insufficient data for calculation",
              days_found: days.length
            });
          }

          // Sort oldest first
          days.sort((a, b) => new Date(a.date) - new Date(b.date));
          const n = days.length;

          // Effort = avg volume over period
          const avgVol = days.reduce((s, d) => s + (d.total_vol || 0), 0) / n;

          // Result = price change from first to last
          const priceChange = days[n - 1].close && days[0].close
            ? ((days[n - 1].close - days[0].close) / days[0].close) * 100
            : 0;

          // Net Quality = avg delta % (how consistent is buying)
          const avgDeltaPct = days.reduce((s, d) => {
            const vol = d.total_vol || 1;
            return s + (d.total_delta / vol) * 100;
          }, 0) / n;

          // Elasticity = price response per unit effort (simplified)
          const elasticity = avgVol > 0 ? priceChange / (avgVol / 1000000) : 0;

          // Determine state based on delta trend
          const recentDelta = days.slice(-5).reduce((s, d) => s + (d.total_delta || 0), 0);
          const earlyDelta = days.slice(0, 5).reduce((s, d) => s + (d.total_delta || 0), 0);

          let state = "NEUTRAL";
          if (recentDelta > earlyDelta * 1.5 && recentDelta > 0) state = "ACCUMULATION";
          else if (recentDelta < earlyDelta * 0.5 && recentDelta < 0) state = "DISTRIBUTION";
          else if (recentDelta > 0 && priceChange > 2) state = "READY_MARKUP";
          else if (recentDelta < 0 && priceChange < -2) state = "POTENTIAL_TOP";

          // Normalize to z-score-like values (-3 to +3 range)
          const normalize = (val, min, max) => Math.max(-3, Math.min(3, ((val - min) / (max - min || 1)) * 6 - 3));

          const features = {
            effort: normalize(avgVol, 0, 10000000),
            response: normalize(priceChange, -10, 10),
            quality: normalize(avgDeltaPct, -50, 50),
            elasticity: normalize(elasticity, -1, 1),
            state: state
          };

          return json({
            symbol: ticker,
            source: "on_demand",
            days_used: n,
            period: `${days[0].date} to ${days[n - 1].date}`,
            features: features,
            raw: {
              avg_volume: Math.round(avgVol),
              price_change_pct: priceChange.toFixed(2),
              avg_delta_pct: avgDeltaPct.toFixed(2),
              elasticity: elasticity.toFixed(4)
            }
          });
        } catch (e) {
          return json({ error: "Calculation error", details: e.message }, 500);
        }
      }

      // 3. GET /brokers (Mapping for frontend)
      if (url.pathname === "/emiten" && req.method === "GET") {
        try {
          const data = await fetchEmitenList(env, {
            status: url.searchParams.get("status"),
            q: url.searchParams.get("q"),
            sector: url.searchParams.get("sector"),
            limit: url.searchParams.get("limit")
          });

          return json({ data, meta: { count: data.length } });
        } catch (err) {
          console.error("[/emiten] Failed to fetch list", err);
          return json({ error: "Failed to fetch emiten list", details: err.message }, 500);
        }
      }

      if (url.pathname === "/brokers" && req.method === "GET") {
        try {
          const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
          return json({ brokers: results || [] }); // Return array or object? User snippet expects { brokers: map } or array?
          // User snippet: "if (d.brokers) brokersMap = d.brokers;" 
          // But normally brokers table is list.
          // However, calculateRangeData in line 46 does: results.forEach(b => brokersMap[b.code] = b);
          // So let's return a map or list.
          // Let's return the list, and let frontend map it, OR map it here.
          // User snippet logic: `fetch... .then(d => { if (d.brokers) brokersMap = d.brokers; })`
          // If d.brokers is expected to be a map { 'YP': {...} }, I should convert it.
          // BUT standard D1 .all() returns array.
          // Let's look at the user snippet usage: `const broker = brokersMap[code];` -> Implies Object/Map.
          // So I should convert array to object here to match user's old API expectation, OR change frontend to map it.
          // Changing frontend is safer as I control it.
          // I will return the list as `brokers` array, and update frontend to reduce it to map.
        } catch (e) {
          return json({ error: "Failed to fetch brokers", details: e.message }, 500);
        }
      }

      // 4. GET /cache-summary (Renamed from /chart-data)
      if (url.pathname === "/cache-summary" && req.method === "GET") {
        const symbol = url.searchParams.get("symbol");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const includeOrderflow = url.searchParams.get("include_orderflow") !== "false";

        let cacheMode = url.searchParams.get("cache") || "default";
        if (url.searchParams.get("reload") === "true") cacheMode = "rebuild";

        if (!symbol || !from || !to) return json({ error: "Missing params (symbol, from, to)" }, 400);

        const key = `broker/summary/v5/${symbol}/${from}_${to}.json`;

        // 1. READ CACHE (Only if mode is default)
        if (cacheMode === "default") {
          const cached = await env.SSSAHAM_EMITEN.get(key);
          if (cached) {
            let cachedData = null;
            try {
              cachedData = await cached.json();
            } catch (_) { }

            if (cachedData && cachedData.summary && cachedData.summary.foreign) {
              if (includeOrderflow) {
                try {
                  const snapshot = await getOrderflowSnapshot(env, symbol);
                  if (snapshot) {
                    cachedData.orderflow = snapshot;
                    const bubblePoint = toOrderflowBubblePoint(symbol, snapshot);
                    cachedData.bubble = cachedData.bubble || {};
                    cachedData.bubble.orderflow = bubblePoint ? [bubblePoint] : [];
                  } else {
                    delete cachedData.orderflow;
                    if (cachedData.bubble && cachedData.bubble.orderflow) {
                      cachedData.bubble.orderflow = [];
                    }
                  }
                } catch (err) {
                  console.error("[cache-summary] attach orderflow (cache) failed:", err);
                }
              }

              return withCORS(new Response(JSON.stringify(cachedData), {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                  "X-Cache": "HIT"
                }
              }));
            }
            // If missing, fallthrough to re-calculate (MISS/STALE)
          }
        }

        // Calculate
        const data = await calculateRangeData(env, ctx, symbol, from, to);
        if (includeOrderflow) {
          try {
            const snapshot = await getOrderflowSnapshot(env, symbol);
            if (snapshot) {
              data.orderflow = snapshot;
              const bubblePoint = toOrderflowBubblePoint(symbol, snapshot);
              if (bubblePoint) {
                data.bubble = data.bubble || {};
                data.bubble.orderflow = [bubblePoint];
              }
            }
          } catch (err) {
            console.error("[cache-summary] attach orderflow failed:", err);
          }
        }

        /**
 * @worker api-saham
 * @objective Provides public API endpoints for stock screener features, z-score history, broker lists, and aggregated broker summary (foreign/retail/local).
 *
 * @endpoints
 * - GET /screener -> Returns latest Z-Score screener data (via R2 pointer) (public)
 * - GET /features/history?symbol=... -> Returns historical Z-Score data for a ticker (public)
 * - GET /brokers -> Returns list of brokers from D1 (public)
 * - GET /cache-summary?symbol=...&from=...&to=... -> Returns aggregated broker summary (cached in R2) (public)
 * - GET /health -> Health check (public)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: none
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: R2 (SSSAHAM_EMITEN, RAW_BROKSUM), D1 (SSSAHAM_DB)
 * - writes: R2 (cache-summary results)
 *
 * @relations
 * - upstream: Data pipelines producing R2 features/broksum (unknown source)
 * - downstream: Frontend Clients
 *
 * @success_metrics
 * - Latency of /cache-summary (cache hit vs miss)
 * - Availability of screener data
 *
 * @notes
 * - Uses R2 'pointer' mechanism to find latest screener file.
 * - Implements 48h caching for broker summary.
 */
        // workers/api-saham/src/index.js
        // 3. WRITE CACHE (If not 'off')
        if (cacheMode !== "off") {
          const ttl = cacheMode === "rebuild" ? 604800 : 172800; // 7 days or 2 days

          let payloadToCache = data;
          if (includeOrderflow) {
            try {
              const cloned = JSON.parse(JSON.stringify(data));
              delete cloned.orderflow;
              if (cloned.bubble && cloned.bubble.orderflow) {
                delete cloned.bubble.orderflow;
                if (Object.keys(cloned.bubble).length === 0) {
                  delete cloned.bubble;
                }
              }
              payloadToCache = cloned;
            } catch (err) {
              console.error("[cache-summary] clone cache payload failed:", err);
              const shallow = { ...data };
              delete shallow.orderflow;
              if (shallow.bubble && shallow.bubble.orderflow) {
                shallow.bubble = { ...shallow.bubble };
                delete shallow.bubble.orderflow;
                if (Object.keys(shallow.bubble).length === 0) {
                  delete shallow.bubble;
                }
              }
              payloadToCache = shallow;
            }
          }

          await env.SSSAHAM_EMITEN.put(key, JSON.stringify(payloadToCache), {
            httpMetadata: {
              contentType: "application/json",
              cacheControl: `public, max-age=${ttl}`
            },
            customMetadata: {
              generated_at: new Date().toISOString(),
              mode: cacheMode,
              ttl: ttl.toString()
            }
          });
        }

        return withCORS(new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "X-Cache-Mode": cacheMode
          }
        }));
      }

      // 5. GET /audit-trail (Proxy to R2)
      if (url.pathname === "/audit-trail" && req.method === "GET") {
        const symbol = url.searchParams.get("symbol");
        const limit = parseInt(url.searchParams.get("limit") || "100");
        if (!symbol) return json({ error: "Missing symbol" }, 400);

        try {
          const key = `audit/${symbol}.json`;
          const obj = await env.SSSAHAM_EMITEN.get(key);
          if (!obj) return json({ ok: true, symbol, entries: [], count: 0 });

          const data = await obj.json();
          let entries = data.entries || [];
          // Slice limit & Reverse (newest first)
          entries = entries.slice(-limit).reverse();

          return json({ ok: true, symbol, entries, count: entries.length });
        } catch (e) {
          return json({ error: "Fetch error", details: e.message }, 500);
        }
      }

      // 6. GET /logo (Proxy Image)
      if (url.pathname === "/logo") {
        const ticker = url.searchParams.get("ticker") || url.searchParams.get("symbol");
        if (!ticker) return json({ error: "Missing ticker or symbol" }, 400);

        // Helper to return Default Logo (IHSG)
        const returnDefault = async () => {
          const defaultKey = "logo/default.jpg";
          const defaultObj = await env.SSSAHAM_EMITEN.get(defaultKey);
          if (defaultObj) {
            const headers = new Headers();
            defaultObj.writeHttpMetadata(headers);
            headers.set('etag', defaultObj.httpEtag);
            headers.set('Cache-Control', 'public, max-age=2592000, immutable'); // Cache 30 days
            headers.set('Access-Control-Allow-Origin', '*');
            return new Response(defaultObj.body, { headers });
          }
          // Final fallback: transparent 1x1
          const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), c => c.charCodeAt(0));
          return new Response(png, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=3600",
              "Access-Control-Allow-Origin": "*"
            }
          });
        };

        const key = `logo/${ticker}.png`;
        let object = await env.SSSAHAM_EMITEN.get(key);

        if (!object) {
          // Read-Through Cache: Fetch from Upstream
          try {
            const upstreamUrl = `https://assets.stockbit.com/logos/companies/${ticker}.png`;
            // console.log(`[LOGO] Fetching upstream: ${upstreamUrl}`);
            const upstreamResp = await fetch(upstreamUrl);

            if (upstreamResp.ok) {
              const blob = await upstreamResp.blob();
              // Save to R2
              await env.SSSAHAM_EMITEN.put(key, blob.stream(), {
                httpMetadata: { contentType: "image/png" }
              });
              // Re-read or construct response
              object = await env.SSSAHAM_EMITEN.get(key);
            } else {
              // Upstream 404 -> Return Default
              return await returnDefault();
            }
          } catch (e) {
            // Fetch Error -> Return Default
            return await returnDefault();
          }
        }

        if (!object) return await returnDefault();

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=2592000, immutable'); // Cache 30 days
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, {
          headers
        });
      }

      // 6.5 DEBUG: Raw File Inspection
      if (url.pathname === "/debug/raw-file") {
        const key = url.searchParams.get("key");
        if (!key) return json({ error: "Missing key" }, 400);

        try {
          const obj = await env.RAW_BROKSUM.get(key);
          if (!obj) return json({ error: "Object not found", key }, 404);
          return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return json({ error: "Fetch error", details: e.message }, 500);
        }
      }

      // ============================================
      // AI ANALYTICS
      // ============================================
      const SCREENSHOT_TTL_SECONDS = 86400; // 24 hours
      const SCREENSHOT_VERSION = "v1";
      const INTRADAY_LABEL = "intraday";
      const SCREENSHOT_EXTENSIONS = ["jpg", "png", "webp"];


      async function resolveScreenshotKey(env, symbol, date, label) {
        for (const ext of SCREENSHOT_EXTENSIONS) {
          const key = `ai-screenshots/${symbol}/${date}_${label}.${ext}`;
          try {
            const head = await env.SSSAHAM_EMITEN.head(key);
            if (head) return key;
          } catch (_) {
            // ignore head errors
          }
        }
        return null;
      }

      function scheduleIntradayCapture(env, symbol, date) {
        const payload = JSON.stringify({ symbol, date, label: INTRADAY_LABEL });

        if (env.AI_SCREENSHOT_SERVICE) {
          return env.AI_SCREENSHOT_SERVICE.fetch(
            new Request("https://ai-screenshot-service/capture/broker-intraday", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: payload
            })
          );
        }

        if (env.AI_SCREENSHOT_SERVICE_URL) {
          const base = env.AI_SCREENSHOT_SERVICE_URL.replace(/\/$/, "");
          return fetch(`${base}/capture/broker-intraday`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload
          });
        }

        console.warn("[AI] No AI_SCREENSHOT_SERVICE configured");
        return null;
      }

      async function ensureScreenshotAvailability(env, ctx, symbol, date, label, { forceRefresh = false } = {}) {
        let key = await resolveScreenshotKey(env, symbol, date, label);
        if (key) return key;

        const triggerPromise = scheduleIntradayCapture(env, symbol, date);
        if (triggerPromise) {
          const guarded = triggerPromise.catch(err => console.error("[AI] Capture trigger failed:", err));
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(guarded);
          }
        }

        const attempts = forceRefresh ? 6 : 3;
        const delayMs = forceRefresh ? 1500 : 1000;

        for (let attempt = 0; attempt < attempts; attempt++) {
          await sleep(delayMs);
          key = await resolveScreenshotKey(env, symbol, date, label);
          if (key) return key;
        }

        return null;
      }

      function sanitizeJsonString(raw) {
        if (typeof raw !== "string") return null;
        let trimmed = raw.trim();

        if (trimmed.startsWith("```")) {
          trimmed = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
        }

        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
          trimmed = trimmed.slice(firstBrace, lastBrace + 1);
        }

        return trimmed;
      }

      function parseModelJson(raw) {
        const sanitized = sanitizeJsonString(raw);
        if (!sanitized) {
          throw new Error("Model response kosong / tidak mengandung JSON");
        }
        return JSON.parse(sanitized);
      }

      // PUT /ai/screenshot?symbol=BBCA&label=7d — upload raw image ke R2
      if (url.pathname === "/ai/screenshot" && req.method === "PUT") {
        const symbolParam = (url.searchParams.get("symbol") || "").trim().toUpperCase();
        const labelParam = (url.searchParams.get("label") || "default").trim();
        const origin = (url.searchParams.get("origin") || "client").toLowerCase();

        if (!symbolParam) {
          return json({ ok: false, error: "Missing ?symbol=" }, 400);
        }

        const ct = req.headers.get("Content-Type") || "";
        if (!ct.startsWith("image/")) {
          return json({ ok: false, error: "Content-Type must be image/*" }, 400);
        }

        const today = new Date().toISOString().split("T")[0];
        let ext = "jpg";
        if (ct.includes("png")) ext = "png";
        else if (ct.includes("webp")) ext = "webp";
        else if (ct.includes("jpeg")) ext = "jpg";

        const resolvedLabel = labelParam.toLowerCase();
        const key = `ai-screenshots/${symbolParam}/${today}_${resolvedLabel}.${ext}`;

        const imgBytes = await req.arrayBuffer();
        const sizeKb = Math.round(imgBytes.byteLength / 1024);
        console.log(`[AI] Upload screenshot ${symbolParam}/${resolvedLabel} (${sizeKb} KB)`);

        await env.SSSAHAM_EMITEN.put(key, imgBytes, {
          httpMetadata: {
            contentType: ct,
            cacheControl: `public, max-age=${SCREENSHOT_TTL_SECONDS}`
          },
          customMetadata: {
            symbol: symbolParam,
            label: resolvedLabel,
            origin,
            version: SCREENSHOT_VERSION,
            uploaded_at: new Date().toISOString()
          }
        });

        if (origin !== "service" && resolvedLabel !== INTRADAY_LABEL) {
          const trigger = scheduleIntradayCapture(env, symbolParam, today);
          if (trigger) {
            ctx.waitUntil(trigger.catch(err => console.error("[AI] Auto capture trigger failed:", err)));
          }
        }

        const publicUrl = `https://api-saham.mkemalw.workers.dev/ai/screenshot?key=${encodeURIComponent(key)}`;
        return json({
          ok: true,
          key,
          url: publicUrl,
          size_kb: sizeKb,
          origin,
          label: resolvedLabel,
          date: today
        });
      }

      // GET /ai/screenshot?key=...  — serve image from R2
      if (url.pathname === "/ai/screenshot" && req.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return json({ ok: false, error: "Missing ?key=" }, 400);

        const obj = await env.SSSAHAM_EMITEN.get(key);
        if (!obj) return json({ ok: false, error: "Not found" }, 404);

        return withCORS(new Response(obj.body, {
          headers: {
            "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
            "Cache-Control": "public, max-age=86400"
          }
        }));
      }

      // POST /ai/analyze-broksum  — multi-image, cached per day
      // POST /ai/analyze-broksum  — multi-image, cached per day
      if (url.pathname === "/ai/analyze-broksum" && req.method === "POST") {
        if (!env.OPENAI_API_KEY) {
          return json({ ok: false, error: "Missing OPENAI_API_KEY in environment" }, 500);
        }

        const contentType = req.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Expected application/json body" }, 400);
        }

        const body = await req.json();
        const { symbol, image_keys } = body; // [{key,label}, ...]
        const forceRefresh = body.force === true;

        const normalizedSymbol = (symbol || "").toString().trim().toUpperCase();
        const originalKeys = Array.isArray(image_keys) ? image_keys : [];
        if (!normalizedSymbol || originalKeys.length === 0) {
          return json({ ok: false, error: "Missing required fields: symbol, image_keys[]" }, 400);
        }

        // Cache key unique per symbol + date range so BBRI/14d and BBRI/30d are separate
        const today = new Date().toISOString().split("T")[0];
        const fromDate = (body.from || today).toString().trim();
        const toDate   = (body.to   || today).toString().trim();
        const cacheKey = `ai-cache/${normalizedSymbol}/${fromDate}_${toDate}.json`;

        if (!forceRefresh) {
          try {
            const cached = await env.SSSAHAM_EMITEN.get(cacheKey);
            if (cached) {
              const cachedData = await cached.json();
              // Honour 24-hour TTL — check cached_at timestamp
              const cachedAt = cachedData.cached_at ? new Date(cachedData.cached_at).getTime() : 0;
              const ageMs = Date.now() - cachedAt;
              if (ageMs < 24 * 60 * 60 * 1000) {
                console.log(`[AI] Cache HIT for ${normalizedSymbol} (${fromDate}→${toDate}), age ${Math.round(ageMs/60000)}min`);
                return json({ ...cachedData, cached: true });
              }
              console.log(`[AI] Cache STALE for ${normalizedSymbol} — age ${Math.round(ageMs/3600000)}h, rebuilding`);
            }
          } catch (_) { }
        }

        // --- de-dupe & normalize screenshot keys
        const aggregatedMap = new Map();
        originalKeys.forEach((ik) => {
          if (!ik || typeof ik.key !== "string") return;
          const key = ik.key;
          const labelRaw = typeof ik.label === "string" ? ik.label.trim() : "screenshot";
          const normalizedLabel = (labelRaw || "screenshot").toLowerCase();
          aggregatedMap.set(key, { key, label: labelRaw || "screenshot", normalizedLabel });
        });

        // Frontend now uploads both brokerflow + intraday screenshots directly from DOM.
        // We no longer call ensureScreenshotAvailability (which used a dummy mock service).
        const labelPresence = new Set(Array.from(aggregatedMap.values()).map(x => x.normalizedLabel));
        console.log(`[AI] Screenshots received from client: ${Array.from(labelPresence).join(', ')}`);
        if (!labelPresence.has("intraday")) {
          console.warn(`[AI] No intraday screenshot provided by client for ${normalizedSymbol}`);
        }

        const aggregatedKeys = Array.from(aggregatedMap.values());
        if (aggregatedKeys.length === 0) {
          return json({ ok: false, error: "No valid screenshots available" }, 400);
        }

        // --- validate screenshot existence (HEAD)
        for (const ik of aggregatedKeys) {
          try {
            const head = await env.SSSAHAM_EMITEN.head(ik.key);
            if (!head) {
              return json({ ok: false, error: `Screenshot not found: ${ik.label || ik.key}` }, 400);
            }
          } catch (headErr) {
            console.error(`[AI] HEAD failed for ${ik.key}:`, headErr);
            return json({ ok: false, error: `Cannot read screenshot: ${ik.label || ik.key}` }, 500);
          }
        }

        // --- load system prompt
        let systemPrompt = null;
        try {
          const promptObj = await env.SSSAHAM_EMITEN.get("prompt/brokersummary_detail_emiten_openai.txt");
          systemPrompt = promptObj ? await promptObj.text() : null;
        } catch (_) { }
        if (!systemPrompt) {
          systemPrompt = "Kamu adalah analis saham Indonesia. Analisis screenshot broker summary ini dan berikan analisis fund flow komprehensif dalam Bahasa Indonesia.";
        }

        const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
        const GROK_URL = "https://api.x.ai/v1/chat/completions";

        const labelList = aggregatedKeys.map(ik => ik.label).join(", ");
        const imageContents = aggregatedKeys.map(ik => ({
          type: "image_url",
          image_url: {
            url: `https://api-saham.mkemalw.workers.dev/ai/screenshot?key=${encodeURIComponent(ik.key)}`,
            detail: "low"
          }
        }));

        const visionPayload = {
          model: "gpt-4.1",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: `Analisis screenshot halaman Broker Summary untuk emiten ${normalizedSymbol}. Screenshot yang tersedia: ${labelList}. Gabungkan analisis dari semua screenshot dan kembalikan JSON valid sesuai schema.` },
                ...imageContents
              ]
            }
          ],
          max_tokens: 4096
        };

        async function callOpenAIWithJsonRetry() {
          let usage = {};
          let rawContent = "";

          const resp = await fetch(OPENAI_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(visionPayload)
          });

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`OpenAI API error: ${resp.status} - ${errText}`);
          }

          const data = await resp.json();
          rawContent = data.choices?.[0]?.message?.content || "";
          usage = data.usage || {};

          try {
            const analysisJson = parseModelJson(rawContent);
            return { analysisJson, rawContent, usage };
          } catch (parseErr) {
            console.error("[AI] First JSON parse failed, retrying:", parseErr.message);

            const correctionPayload = {
              ...visionPayload,
              messages: [
                ...visionPayload.messages,
                { role: "assistant", content: rawContent },
                {
                  role: "user",
                  content: `The previous response was not valid JSON. Error: ${parseErr.message}. Please correct the output and provide only the valid JSON object, without any surrounding text or markdown formatting.`
                }
              ]
            };

            const retryResp = await fetch(OPENAI_URL, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(correctionPayload)
            });

            if (!retryResp.ok) {
              const retryErrText = await retryResp.text();
              throw new Error(`OpenAI retry API error: ${retryResp.status} - ${retryErrText}`);
            }

            const retryData = await retryResp.json();
            rawContent = retryData.choices?.[0]?.message?.content || rawContent;

            // keep latest usage (or merge if you prefer)
            usage = retryData.usage || usage;

            const analysisJson = parseModelJson(rawContent);
            return { analysisJson, rawContent, usage };
          }
        }

        async function callGrokTextOnly() {
          if (!env.GROK_API_KEY) {
            throw new Error("Missing GROK_API_KEY for fallback");
          }

          const textOnlyPayload = {
            model: "grok-4",
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `Analisis data broker summary untuk emiten ${normalizedSymbol}. Screenshot labels tersedia: ${labelList}. (fallback text-only) Kembalikan JSON valid sesuai schema.`
              }
            ],
            max_tokens: 4096
          };

          const resp = await fetch(GROK_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GROK_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(textOnlyPayload)
          });

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Grok API error: ${resp.status} - ${errText}`);
          }

          const data = await resp.json();
          const rawContent = data.choices?.[0]?.message?.content || "";
          const usage = data.usage || {};

          const analysisJson = parseModelJson(rawContent);
          return { analysisJson, rawContent, usage };
        }

        async function callClaudeWithImages() {
          if (!env.ANTHROPIC_API_KEY) {
            throw new Error("Missing ANTHROPIC_API_KEY for fallback");
          }

          const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

          // Claude only accepts these media types
          const VALID_CLAUDE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
          // Min size to skip placeholder/stub images (10x10 pixel dumps = ~122 bytes)
          const MIN_IMAGE_BYTES = 5000;

          // Fetch images directly from R2 and encode as base64
          // (Claude cannot fetch from our worker URL — Anthropic servers cannot reach it)
          const imageBlocks = (await Promise.all(aggregatedKeys.map(async ik => {
            const obj = await env.SSSAHAM_EMITEN.get(ik.key);
            if (!obj) {
              console.warn(`[Claude] Screenshot missing in R2: ${ik.key}, skipping`);
              return null;
            }

            const arrayBuffer = await obj.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);

            // Skip placeholder/stub images (e.g. 10x10 fallback PNG saved when screenshot fails)
            if (bytes.length < MIN_IMAGE_BYTES) {
              console.warn(`[Claude] Image ${ik.label} is too small (${bytes.length} bytes) — likely a placeholder, skipping`);
              return null;
            }

            // Chunked base64 encoding — avoids stack overflow on large images
            const chunkSize = 8192;
            let binary = '';
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            }
            const base64Data = btoa(binary);

            // Normalize media type — Claude rejects "image/jpg" or unknown types
            let mediaType = (obj.httpMetadata?.contentType || "image/jpeg").toLowerCase().split(";")[0].trim();
            if (mediaType === "image/jpg") mediaType = "image/jpeg";
            if (!VALID_CLAUDE_TYPES.has(mediaType)) mediaType = "image/jpeg";

            console.log(`[Claude] Image ${ik.label}: ${bytes.length} bytes, type: ${mediaType}`);

            return {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Data }
            };
          }))).filter(Boolean); // remove nulls (skipped images)

          // If no valid images, fall back to text-only analysis
          const hasImages = imageBlocks.length > 0;
          console.log(`[Claude] ${hasImages ? imageBlocks.length + ' valid images' : 'no valid images — text-only mode'}`);

          const userContent = hasImages
            ? [
                ...imageBlocks,
                { type: "text", text: `Analisis screenshot halaman Broker Summary untuk emiten ${normalizedSymbol}. Screenshot yang tersedia: ${labelList}. Gabungkan analisis dari semua screenshot dan kembalikan JSON valid sesuai schema.` }
              ]
            : [
                { type: "text", text: `Analisis data broker summary untuk emiten ${normalizedSymbol}. Screenshot labels tersedia: ${labelList}. (fallback text-only) Kembalikan JSON valid sesuai schema.` }
              ];

          // Explicit JSON instruction appended for Claude — Claude ignores vague "return JSON" prompts
          const claudeSystemPrompt = systemPrompt +
            "\n\nPENTING: Respons kamu HARUS berupa JSON object yang valid saja. " +
            "Jangan tambahkan teks pengantar, penjelasan, atau markdown code block (``` json). " +
            "Mulai langsung dengan karakter '{' dan akhiri dengan '}'.";

          const claudePayload = {
            model: "claude-sonnet-4-5",
            max_tokens: 4096,
            system: claudeSystemPrompt,
            messages: [
              {
                role: "user",
                content: userContent
              }
            ]
          };

          const resp = await fetch(CLAUDE_URL, {
            method: "POST",
            headers: {
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            },
            body: JSON.stringify(claudePayload)
          });

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Claude API error: ${resp.status} - ${errText}`);
          }

          const data = await resp.json();
          let rawContent = data.content?.[0]?.text || "";
          const claudeUsage = {
            prompt_tokens: data.usage?.input_tokens,
            completion_tokens: data.usage?.output_tokens,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
          };

          // First parse attempt
          try {
            const analysisJson = parseModelJson(rawContent);
            return { analysisJson, rawContent, usage: claudeUsage };
          } catch (parseErr) {
            console.warn(`[Claude] First parse failed: ${parseErr.message}. Sending correction turn.`);

            // Send a correction turn asking Claude to fix its own output
            const correctionResp = await fetch(CLAUDE_URL, {
              method: "POST",
              headers: {
                "x-api-key": env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "claude-sonnet-4-5",
                max_tokens: 4096,
                system: claudeSystemPrompt,
                messages: [
                  { role: "user", content: userContent },
                  { role: "assistant", content: rawContent },
                  { role: "user", content: `Output sebelumnya bukan JSON valid. Error: ${parseErr.message}. Tolong perbaiki dan kembalikan HANYA JSON object yang valid, mulai dari '{' langsung tanpa teks lain.` }
                ]
              })
            });

            if (!correctionResp.ok) {
              const errText = await correctionResp.text();
              throw new Error(`Claude correction error: ${correctionResp.status} - ${errText}`);
            }

            const correctionData = await correctionResp.json();
            rawContent = correctionData.content?.[0]?.text || rawContent;
            const analysisJson = parseModelJson(rawContent);
            return { analysisJson, rawContent, usage: claudeUsage };
          }
        } // end callClaudeWithImages

        // --- run provider with fallback chain: OpenAI → Grok → Claude
        let provider = "openai";
        let modelUsed = "gpt-4.1";
        let analysisJson = null;
        let rawContent = "";
        let usage = {};

        try {
          console.log(`[AI] Calling OpenAI for ${normalizedSymbol} with ${aggregatedKeys.length} images`);
          const out = await callOpenAIWithJsonRetry();
          analysisJson = out.analysisJson;
          rawContent = out.rawContent;
          usage = out.usage || {};
        } catch (openaiErr) {
          console.warn(`[AI] OpenAI failed: ${openaiErr.message}. Falling back to Grok.`);
          provider = "grok";
          modelUsed = "grok-4";

          try {
            const out = await callGrokTextOnly();
            analysisJson = out.analysisJson;
            rawContent = out.rawContent;
            usage = out.usage || {};
          } catch (grokErr) {
            console.warn(`[AI] Grok fallback failed: ${grokErr.message}. Falling back to Claude.`);
            provider = "claude";
            modelUsed = "claude-sonnet-4-5";

            try {
              const out = await callClaudeWithImages();
              analysisJson = out.analysisJson;
              rawContent = out.rawContent;
              usage = out.usage || {};
            } catch (claudeErr) {
              console.error("[AI] Claude fallback failed:", claudeErr.message);
              return json(
                {
                  ok: false,
                  error: "All AI providers failed",
                  openai: openaiErr.message,
                  grok: grokErr.message,
                  claude: claudeErr.message
                },
                502
              );
            }
          }
        }

        if (!analysisJson || typeof analysisJson !== "object") {
          return json({ ok: false, error: "Model returned invalid JSON structure", raw_output: rawContent }, 502);
        }

        // --- normalize meta fields
        analysisJson.meta = analysisJson.meta && typeof analysisJson.meta === "object" ? analysisJson.meta : {};
        analysisJson.meta.symbol = analysisJson.meta.symbol || normalizedSymbol;
        analysisJson.meta.date_range = analysisJson.meta.date_range || analysisJson.meta.range || "unknown";
        analysisJson.meta.screenshots = Array.from(new Set(aggregatedKeys.map(k => k.label)));
        if (typeof analysisJson.meta.confidence !== "number" || Number.isNaN(analysisJson.meta.confidence)) {
          analysisJson.meta.confidence = Number(analysisJson.meta.confidence) || 0;
        }

        if (analysisJson.recommendation && typeof analysisJson.recommendation === "object") {
          const rec = analysisJson.recommendation;
          if (!Array.isArray(rec.rationale)) rec.rationale = [];
          if (!Array.isArray(rec.risks)) rec.risks = [];
          if (typeof rec.confidence !== "number" || Number.isNaN(rec.confidence)) {
            rec.confidence = Number(rec.confidence) || 0;
          }
        }

        // Also normalize Indonesian-keyed recommendation block
        const recID = analysisJson.kesimpulan_rekomendasi;
        if (recID && typeof recID === "object") {
          // Derive confidence from tingkat_keyakinan if present
          if (recID.tingkat_keyakinan != null && recID.confidence == null) {
            const raw = recID.tingkat_keyakinan;
            if (typeof raw === "number") {
              recID.confidence = raw > 1 ? raw / 100 : raw;
            } else if (typeof raw === "string") {
              const pct = parseFloat(raw.replace("%", ""));
              recID.confidence = !isNaN(pct) ? (pct > 1 ? pct / 100 : pct) : null;
            }
          }
          // Auto-derive confidence from strength of signals if still missing
          if (recID.confidence == null || recID.confidence === 0) {
            const rating = (recID.rating || recID.rekomendasi || "").toUpperCase();
            const alasanCount = Array.isArray(recID.alasan_rating) ? recID.alasan_rating.length : 0;
            let baseConf = 0.5;
            if (/STRONG BUY|STRONG SELL/.test(rating)) baseConf = 0.85;
            else if (/BUY|SELL|AKUMULASI|DISTRIBUSI/.test(rating)) baseConf = 0.75;
            else if (/HOLD|NETRAL|WAIT/.test(rating)) baseConf = 0.6;
            // More rationale = higher confidence
            recID.confidence = Math.min(0.95, baseConf + alasanCount * 0.03);
          }
          // Mirror to meta for backwards compat
          if (analysisJson.meta) {
            analysisJson.meta.confidence = recID.confidence;
          }
        }

        const screenshotsPayload = aggregatedKeys.map(ik => ({
          label: ik.label,
          url: `https://api-saham.mkemalw.workers.dev/ai/screenshot?key=${encodeURIComponent(ik.key)}`
        }));

        const result = {
          ok: true,
          symbol: normalizedSymbol,
          provider,
          model: modelUsed,
          analysis: analysisJson,
          analysis_raw: rawContent,
          screenshots: screenshotsPayload,
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens
          },
          analyzed_at: new Date().toISOString(),
          cached_at: new Date().toISOString(),
          date_range: { from: fromDate, to: toDate }
        };

        try {
          await env.SSSAHAM_EMITEN.put(cacheKey, JSON.stringify(result), {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { symbol: normalizedSymbol, generated_at: new Date().toISOString() }
          });
          console.log(`[AI] Cached result: ${cacheKey}`);
        } catch (cacheErr) {
          console.error("[AI] Failed to cache result:", cacheErr);
        }

        return json(result);
      }


      // 7. Docs/Health
      if (url.pathname === "/health") return json({ ok: true, service: "api-saham" });

      // PROXY: Integrity Scan (to features-service via Service Binding)
      if (url.pathname === "/integrity-scan") {
        return env.FEATURES_SERVICE.fetch(req);
      }

      // Fallback
      return json({ error: "Not Found", method: req.method, path: url.pathname }, 404);

    } catch (err) {
      return json({ error: "Worker Error", details: err.stack || String(err) }, 500);
    }
  }
}
// ==============================
// TEST HOOKS (Vitest)
// ==============================
// Safe: tidak mengubah runtime worker, cuma untuk unit test import.
export const __test__ = {
  checkDataCompleteness,
  shouldRepairFootprint,
  isWeekendUTC,
  prevTradingDayUTC,
  countMissingSessionHours,
  buildFromFallbackTimeline,
  getTodayOrderflowWindow,
  buildEmitenQuery,
  normalizeStatusFilter,
  normalizeSectorFilter,
  normalizeSearchQuery,
  clampLimit
};
