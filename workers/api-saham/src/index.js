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
 * GET /cache-summary?symbol=BBRI&from=YYYY-MM-DD&to=YYYY-MM-DD[&cache=default|rebuild|off][&reload=true][&include_orderflow=true]
 * - Range broker summary aggregation + top brokers + aggregated foreign/retail/local
 * - Cache read/write (R2): broker/summary/v7/{symbol}/{from}_{to}.json
 * - If include_orderflow=true: attaches /orderflow snapshot (D1 temp_footprint_consolidate + daily_features)
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
  const processedStatsMap = fromDateStr === toDateStr
    ? await fetchProcessedDailyStatsMap(env, fromDateStr)
    : new Map();
  const prevProcessedStatsMap = fromDateStr === toDateStr
    ? await fetchProcessedDailyStatsMap(env, prevTradingDayUTC(fromDateStr))
    : new Map();
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

const PUBLIC_PATHS = new Set(["/", "/docs", "/console", "/openapi.json", "/health", "/screener", "/screener-accum", "/cache-summary", "/cache-summary/broker-daily", "/features/history"]);

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

const BROKERS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const brokersReferenceCache = {
  rows: null,
  byCode: null,
  fetchedAt: 0,
  inFlight: null
};

function isBrokersReferenceFresh() {
  return Array.isArray(brokersReferenceCache.rows)
    && brokersReferenceCache.rows.length > 0
    && (Date.now() - brokersReferenceCache.fetchedAt) < BROKERS_CACHE_TTL_MS
    && brokersReferenceCache.byCode
    && typeof brokersReferenceCache.byCode === "object";
}

function buildBrokersCodeMap(rows = []) {
  const map = Object.create(null);
  for (const row of rows) {
    const code = String(row?.code || "").trim();
    if (!code) continue;
    map[code] = row;
  }
  return map;
}

async function loadBrokersReferenceFromD1(env) {
  const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
  const rows = Array.isArray(results) ? results : [];
  const byCode = buildBrokersCodeMap(rows);
  brokersReferenceCache.rows = rows;
  brokersReferenceCache.byCode = byCode;
  brokersReferenceCache.fetchedAt = Date.now();
  return { rows, byCode };
}

async function getBrokersReference(env) {
  if (isBrokersReferenceFresh()) {
    return {
      rows: brokersReferenceCache.rows,
      byCode: brokersReferenceCache.byCode
    };
  }

  if (!env?.SSSAHAM_DB) return { rows: [], byCode: Object.create(null) };

  if (!brokersReferenceCache.inFlight) {
    brokersReferenceCache.inFlight = loadBrokersReferenceFromD1(env)
      .finally(() => {
        brokersReferenceCache.inFlight = null;
      });
  }
  return brokersReferenceCache.inFlight;
}

async function getBrokersRowsCached(env) {
  const { rows } = await getBrokersReference(env);
  return rows;
}

async function getBrokersMapCached(env) {
  const { byCode } = await getBrokersReference(env);
  return Object.assign(Object.create(null), byCode || {});
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
// IDX public holidays (market-closed weekdays)
const IDX_HOLIDAYS = new Set([
  // 2025
  '2025-01-01','2025-01-27','2025-01-28','2025-03-28','2025-03-31',
  '2025-04-01','2025-04-18','2025-05-01','2025-05-12','2025-05-29',
  '2025-06-01','2025-06-06','2025-06-27','2025-09-05',
  '2025-12-25','2025-12-26',
  // 2026
  '2026-01-01','2026-02-16','2026-02-17','2026-03-11',
  '2026-03-18','2026-03-19','2026-03-20','2026-03-23','2026-03-24',
  '2026-04-01','2026-04-02','2026-04-03','2026-04-10','2026-05-01',
  '2026-05-21','2026-06-01','2026-06-08','2026-06-29','2026-08-17',
  '2026-09-08','2026-12-25','2026-12-26'
]);

// Use T12:00Z to avoid timezone edge-shifts
function isWeekendUTC(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun,6=Sat
  return dow === 0 || dow === 6;
}

function isHolidayUTC(dateStr) {
  return IDX_HOLIDAYS.has(dateStr);
}

/** Returns true if dateStr is a weekend OR an IDX public holiday */
function isNonTradingDayUTC(dateStr) {
  return isWeekendUTC(dateStr) || isHolidayUTC(dateStr);
}

function prevTradingDayUTC(dateStr) {
  let d = new Date(`${dateStr}T12:00:00Z`);
  do {
    d = new Date(d.getTime() - 86400000); // -1 day
  } while ([0, 6].includes(d.getUTCDay()) || IDX_HOLIDAYS.has(d.toISOString().slice(0, 10)));
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

async function readJsonlTailFromR2(bucket, key, tailCount = 1) {
  const obj = await bucket.get(key);
  if (!obj) return [];
  const txt = await obj.text();
  if (!txt) return [];

  const lines = txt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];
  const tail = lines.slice(-Math.max(1, tailCount));
  const out = [];
  for (const ln of tail) {
    try {
      out.push(JSON.parse(ln));
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function getRecentWibDates(maxDays = 5) {
  const dates = [];
  for (let i = 0; i < maxDays; i++) {
    const ts = Date.now() - (i * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ts));
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    dates.push(`${get("year")}-${get("month")}-${get("day")}`);
  }
  return dates;
}

/**
 * Returns the most recent trading day in WIB timezone (YYYY-MM-DD).
 * Skips weekends and IDX holidays, walking backwards from today.
 */
function getLastTradingDayWIB() {
  for (let i = 0; i < 10; i++) {
    const ts = Date.now() - (i * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ts));
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
    if (!isNonTradingDayUTC(dateStr)) return dateStr;
  }
  return getRecentWibDates(1)[0]; // fallback
}

async function ensureDashboardTables(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS feed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      symbol TEXT,
      title TEXT NOT NULL,
      body TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_events_created_at ON feed_events(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feed_events_type_created_at ON feed_events(event_type, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feed_events_symbol_created_at ON feed_events(symbol, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS pubex (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      periode TEXT NOT NULL,
      kode_emiten TEXT NOT NULL,
      nama_perusahaan TEXT,
      tanggal TEXT NOT NULL,
      pukul_wib TEXT,
      lokasi TEXT,
      agenda TEXT,
      sumber TEXT,
      ingest_batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pubex_event_time ON pubex(tanggal, pukul_wib)`,
    `CREATE INDEX IF NOT EXISTS idx_pubex_periode ON pubex(periode)`,
    `CREATE INDEX IF NOT EXISTS idx_pubex_symbol_date ON pubex(kode_emiten, tanggal)`,

    `CREATE TABLE IF NOT EXISTS ipo_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_code TEXT,
      company_name TEXT,
      event_name TEXT,
      event_date TEXT NOT NULL,
      event_time_wib TEXT,
      location TEXT,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ipo_events_time ON ipo_events(event_date, event_time_wib)`,

    `CREATE TABLE IF NOT EXISTS catalyst_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'ipot_calca',
      event_type TEXT NOT NULL,
      event_subtype TEXT,
      seq TEXT,
      event_ts INTEGER,
      event_date TEXT NOT NULL,
      event_time_wib TEXT,
      symbol_primary TEXT,
      symbols_json TEXT,
      status TEXT,
      phase TEXT,
      label TEXT,
      sector_primary TEXT,
      detail_pending INTEGER NOT NULL DEFAULT 0,
      raw_line TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source, event_type, seq, event_ts, symbol_primary, phase)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalyst_events_time ON catalyst_events(event_date, event_time_wib)`,
    `CREATE INDEX IF NOT EXISTS idx_catalyst_events_symbol_time ON catalyst_events(symbol_primary, event_date)`,

    `CREATE TABLE IF NOT EXISTS catalyst_ca_detail (
      seq TEXT PRIMARY KEY,
      sec TEXT,
      act_type TEXT,
      description_html TEXT,
      description_text TEXT,
      amount REAL,
      ratio1 REAL,
      ratio2 REAL,
      cum_date TEXT,
      ex_date TEXT,
      rec_date TEXT,
      start_dist_date TEXT,
      end_dist_date TEXT,
      status TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS catalyst_sector_cache (
      symbol TEXT PRIMARY KEY,
      sector TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ipot_session_cache (
      cache_key TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of ddl) {
    await env.SSSAHAM_DB.prepare(sql).run();
  }
}

function normalizeIsoDate(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  const dmy = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    const yyyy = dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function normalizeWibTime(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = String(Math.max(0, Math.min(23, Number(m[1])))).padStart(2, "0");
  const mm = String(Math.max(0, Math.min(59, Number(m[2])))).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseJsonFromModel(raw) {
  if (typeof raw !== "string") throw new Error("Model response invalid");
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first >= 0 && last > first) txt = txt.slice(first, last + 1);
  return JSON.parse(txt);
}

function toEventTimestamp(dateIso, timeHHmm) {
  const d = normalizeIsoDate(dateIso);
  const t = normalizeWibTime(timeHHmm || "00:00") || "00:00";
  if (!d) return Number.MAX_SAFE_INTEGER;
  return new Date(`${d}T${t}:00+07:00`).getTime();
}

function formatWibDateHour(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  return {
    date: `${yyyy}-${mm}-${dd}`,
    hour: hh
  };
}

async function saveCatalystRawSnapshot(env, {
  queryType,
  cmdid,
  cid,
  batchId,
  requestPayload,
  records,
  seq,
  syncedAt
}) {
  try {
    if (!env?.SSSAHAM_EMITEN?.put) return null;
    const { date, hour } = formatWibDateHour(Date.now());
    const safeQuery = String(queryType || "unknown").replace(/[^a-z0-9_\-]/gi, "_").toLowerCase();
    const safeSeq = seq ? `seq=${String(seq).replace(/[^a-z0-9_\-]/gi, "_")}/` : "";
    const key = `catalyst/raw/v1/date=${date}/hour=${hour}/query=${safeQuery}/batch=${batchId}/${safeSeq}cid=${cid}-cmdid=${cmdid}.ndjson`;

    const header = {
      kind: "meta",
      synced_at: syncedAt,
      query_type: safeQuery,
      cmdid,
      cid,
      batch_id: batchId,
      request: requestPayload || null,
      total_records: Array.isArray(records) ? records.length : 0
    };

    const lines = [JSON.stringify(header)];
    const list = Array.isArray(records) ? records : [];
    for (let i = 0; i < list.length; i++) {
      lines.push(JSON.stringify({ kind: "record", idx: i, data: list[i] ?? null }));
    }

    await env.SSSAHAM_EMITEN.put(key, `${lines.join("\n")}\n`, {
      httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" }
    });
    return key;
  } catch (e) {
    console.error("[catalyst.raw] save snapshot failed", e?.message || e);
    return null;
  }
}

function makeWebSocketKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function fetchIpotAppSession(env) {
  const nowSec = Math.floor(Date.now() / 1000);

  // Primary cache (10 min)
  try {
    const primary = await env.SSSAHAM_DB.prepare(
      `SELECT token, expires_at FROM ipot_session_cache WHERE cache_key = ? LIMIT 1`
    ).bind("IPOT_APPSESSION").first();
    if (primary?.token && Number(primary.expires_at || 0) > nowSec) {
      return String(primary.token);
    }
  } catch {
    // ignore cache read error, proceed to network fetch
  }

  const url = env.IPOT_APPSESSION_URL || "https://indopremier.com/ipc/appsession.js";
  const origin = env.IPOT_ORIGIN || "https://indopremier.com";
  try {
    const resp = await fetch(url, {
      headers: {
        "Accept": "*/*",
        "User-Agent": "api-saham/1.0",
        "Origin": origin,
        "Referer": `${origin}/`
      }
    });
    if (!resp.ok) throw new Error(`appsession fetch failed: ${resp.status}`);

    const text = await resp.text();
    const patterns = [
      /appsession\s*[:=]\s*["']([^"']+)["']/i,
      /appsession=([a-zA-Z0-9\-_]+)/i,
      /["']appsession["']\s*[:,]\s*["']([^"']+)["']/i,
    ];

    let token = null;
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) {
        token = m[1];
        break;
      }
    }

    if (!token) {
      const near = text.match(/appsession[^A-Za-z0-9\-_]{0,30}([A-Za-z0-9\-_]{16,128})/i);
      if (near?.[1]) token = near[1];
    }

    if (!token) throw new Error("could not parse appsession token");

    const updatedAt = new Date().toISOString();
    await env.SSSAHAM_DB.prepare(
      `INSERT INTO ipot_session_cache (cache_key, token, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         token=excluded.token,
         expires_at=excluded.expires_at,
         updated_at=excluded.updated_at`
    ).bind("IPOT_APPSESSION", token, nowSec + 600, updatedAt).run();

    await env.SSSAHAM_DB.prepare(
      `INSERT INTO ipot_session_cache (cache_key, token, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         token=excluded.token,
         expires_at=excluded.expires_at,
         updated_at=excluded.updated_at`
    ).bind("IPOT_APPSESSION_BACKUP", token, nowSec + 21600, updatedAt).run();

    return token;
  } catch (e) {
    // Stale-if-error fallback to backup cache
    try {
      const backup = await env.SSSAHAM_DB.prepare(
        `SELECT token FROM ipot_session_cache WHERE cache_key = ? LIMIT 1`
      ).bind("IPOT_APPSESSION_BACKUP").first();
      if (backup?.token) {
        console.warn(`[catalyst] fetchIpotAppSession fallback to backup: ${e?.message || e}`);
        return String(backup.token);
      }
    } catch {
      // ignore and rethrow original
    }

    throw e;
  }
}

async function clearIpotAppSession(env) {
  try {
    await env.SSSAHAM_DB.prepare(
      `DELETE FROM ipot_session_cache WHERE cache_key IN (?, ?)`
    ).bind("IPOT_APPSESSION", "IPOT_APPSESSION_BACKUP").run();
  } catch {
    // ignore clear errors
  }
}

function epochSecToWibParts(epochSec) {
  const sec = Number(epochSec);
  if (!Number.isFinite(sec) || sec <= 0) return { date: null, time: null, ts: null };
  const dt = new Date(sec * 1000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(dt);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mi = get("minute");
  const date = yyyy && mm && dd ? `${yyyy}-${mm}-${dd}` : null;
  const time = hh && mi ? `${hh}:${mi}` : null;
  return { date, time, ts: dt.getTime() };
}

function stripHtml(raw) {
  const txt = String(raw || "");
  return txt
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|li|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseCalcaLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const p = line.split("|").map((s) => String(s || "").trim());
  while (p.length < 12) p.push("");
  const [eventType, eventSubtype, seq, epochSec, year, month, day, symbolsCsv, primarySymbol, status, phase, label] = p;

  const symbols = String(symbolsCsv || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const wib = epochSecToWibParts(epochSec);
  const dateFallback =
    year && month && day
      ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : null;

  const symbolPrimary = String(primarySymbol || symbols[0] || "").trim().toUpperCase() || null;
  const eventDate = normalizeIsoDate(wib.date || dateFallback);
  const eventTime = normalizeWibTime(wib.time || "");
  const eventTs = Number.isFinite(wib.ts) ? wib.ts : toEventTimestamp(eventDate, eventTime || "00:00");

  if (!eventDate) return null;

  return {
    source: "ipot_calca",
    event_type: String(eventType || "").toUpperCase() || "UNKNOWN",
    event_subtype: eventSubtype || null,
    seq: seq || null,
    event_ts: Number.isFinite(eventTs) ? eventTs : null,
    event_date: eventDate,
    event_time_wib: eventTime || null,
    symbol_primary: symbolPrimary,
    symbols,
    status: status || null,
    phase: phase || null,
    label: label || null,
    raw_line: line
  };
}

function calcCatalystSubtitle(row) {
  const phase = String(row?.phase || "").trim();
  if (phase) {
    const m = {
      cum: "Cum Date",
      ex: "Ex Date",
      rec: "Recording Date",
      start: "Start",
      end: "End"
    };
    return m[phase.toLowerCase()] || phase;
  }
  return row?.event_subtype || null;
}

async function connectIpotSocket(env) {
  const appsession = await fetchIpotAppSession(env);
  const origin = env.IPOT_ORIGIN || "https://indopremier.com";
  const base = env.IPOT_WS_HTTP_BASE || "https://ipotapp.ipot.id/socketcluster/";
  const wsUrl = new URL(base);
  wsUrl.searchParams.set("appsession", appsession);
  const wsHttpUrl = wsUrl.toString().startsWith("wss://")
    ? `https://${wsUrl.toString().slice("wss://".length)}`
    : wsUrl.toString().startsWith("ws://")
      ? `http://${wsUrl.toString().slice("ws://".length)}`
      : wsUrl.toString();

  const resp = await fetch(wsHttpUrl, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      Origin: origin,
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": makeWebSocketKey(),
      "User-Agent": "api-saham/1.0"
    }
  });
  if (!resp.webSocket) throw new Error(`WS upgrade failed: ${resp.status}`);
  const ws = resp.webSocket;
  ws.accept();
  try {
    ws.send(JSON.stringify({ event: "#handshake", data: { authToken: env.IPOT_AUTH_TOKEN || null }, cid: 1 }));
  } catch {}
  return ws;
}

async function ipotQueryRecords(ws, cmdid, param, cid, opts = {}) {
  const records = [];
  const idleMs = Number(opts.idleMs || 800);
  const maxMs = Number(opts.maxMs || 8000);
  const emptyIdleMs = Number(opts.emptyIdleMs || 2500);
  let lastAt = Date.now();
  const startAt = Date.now();
  let gotRes = false;
  let resAt = null;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not open");
  }

  const onMsg = (ev) => {
    lastAt = Date.now();
    const txt = typeof ev.data === "string" ? ev.data : "";
    if (txt === "#1") {
      try { ws.send("#2"); } catch {}
      return;
    }
    let j;
    try { j = JSON.parse(txt); } catch { return; }

    const msgCmdid = Number(j?.data?.cmdid);
    if (j?.event === "record" && msgCmdid === Number(cmdid)) {
      records.push(j?.data?.data);
    }
    if (j?.event === "res" && msgCmdid === Number(cmdid)) {
      gotRes = true;
      resAt = Date.now();
    }
  };

  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ event: "cmd", data: { cmdid, param }, cid }));

  while (true) {
    const now = Date.now();
    if (now - startAt > maxMs) break;
    if (gotRes && resAt && now - resAt > 500) break;
    if (records.length > 0 && now - lastAt > idleMs) break;
    if (records.length === 0 && now - lastAt > emptyIdleMs) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  ws.removeEventListener("message", onMsg);
  return records;
}

async function runIpotCatalystSync(env, { fromDate, toDate, includeDetail = true, detailLimit = 100 } = {}) {
  await ensureDashboardTables(env);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const from = normalizeIsoDate(fromDate) || new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const to = normalizeIsoDate(toDate) || new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

  let ws;
  try {
    ws = await connectIpotSocket(env);
  } catch (e) {
    console.warn(`[catalyst] WS connect failed, resetting appsession and retrying once: ${e?.message || e}`);
    await clearIpotAppSession(env);
    ws = await connectIpotSocket(env);
  }
  const batchId = crypto.randomUUID();
  let cid = 70;
  let cmdid = 70;
  const nextCid = () => ++cid;
  const nextCmdid = () => ++cmdid;
  const rawKeys = [];

  try {
    const calcaCmd = nextCmdid();
    const calcaCid = nextCid();
    const calcaRequest = {
      service: "midata",
      cmd: "query",
      param: {
        source: "common",
        index: "CALCA",
        args: ["<>", from, to]
      }
    };
    const calcaRecordsRaw = await ipotQueryRecords(
      ws,
      calcaCmd,
      calcaRequest,
      calcaCid,
      { maxMs: 12000, emptyIdleMs: 3500 }
    );
    {
      const key = await saveCatalystRawSnapshot(env, {
        queryType: "calca",
        cmdid: calcaCmd,
        cid: calcaCid,
        batchId,
        requestPayload: calcaRequest,
        records: calcaRecordsRaw,
        syncedAt: new Date().toISOString()
      });
      if (key) rawKeys.push(key);
    }

    const parsedEvents = (calcaRecordsRaw || [])
      .map((line) => parseCalcaLine(String(line || "")))
      .filter(Boolean);

    const symbols = [...new Set(parsedEvents.flatMap((e) => e.symbols || []).filter(Boolean))];
    const sectorMap = new Map();

    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const secCmd = nextCmdid();
      const secCid = nextCid();
      const secRequest = {
        cmd: "query",
        service: "mi",
        param: {
          source: "jsx",
          index: "sector",
          args: { code: chunk }
        }
      };
      const secRecs = await ipotQueryRecords(
        ws,
        secCmd,
        secRequest,
        secCid,
        { maxMs: 9000, emptyIdleMs: 2000 }
      );
      {
        const key = await saveCatalystRawSnapshot(env, {
          queryType: "sector",
          cmdid: secCmd,
          cid: secCid,
          batchId,
          requestPayload: secRequest,
          records: secRecs,
          syncedAt: new Date().toISOString()
        });
        if (key) rawKeys.push(key);
      }

      for (const r of secRecs || []) {
        const code = String(r?.code || "").trim().toUpperCase();
        const sector = String(r?.data || "").trim() || null;
        if (code) sectorMap.set(code, sector);
      }
    }

    const nowIso = new Date().toISOString();
    let upsertedEvents = 0;
    for (const ev of parsedEvents) {
      const sectorPrimary = sectorMap.get(ev.symbol_primary || "") || null;
      await env.SSSAHAM_DB.prepare(
        `INSERT INTO catalyst_events
          (source, event_type, event_subtype, seq, event_ts, event_date, event_time_wib, symbol_primary, symbols_json, status, phase, label, sector_primary, detail_pending, raw_line, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, event_type, seq, event_ts, symbol_primary, phase)
         DO UPDATE SET
          event_subtype=excluded.event_subtype,
          event_date=excluded.event_date,
          event_time_wib=excluded.event_time_wib,
          symbols_json=excluded.symbols_json,
          status=excluded.status,
          label=excluded.label,
          sector_primary=excluded.sector_primary,
          detail_pending=excluded.detail_pending,
          raw_line=excluded.raw_line,
          updated_at=excluded.updated_at`
      ).bind(
        ev.source,
        ev.event_type,
        ev.event_subtype,
        ev.seq,
        ev.event_ts,
        ev.event_date,
        ev.event_time_wib,
        ev.symbol_primary,
        JSON.stringify(ev.symbols || []),
        ev.status,
        ev.phase,
        ev.label,
        sectorPrimary,
        ev.event_type === "CA" ? 1 : 0,
        ev.raw_line,
        nowIso,
        nowIso
      ).run();
      upsertedEvents++;

      if (ev.symbol_primary && sectorPrimary !== null) {
        await env.SSSAHAM_DB.prepare(
          `INSERT INTO catalyst_sector_cache (symbol, sector, fetched_at)
           VALUES (?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET sector=excluded.sector, fetched_at=excluded.fetched_at`
        ).bind(ev.symbol_primary, sectorPrimary, nowIso).run();
      }
    }

    let detailFetched = 0;
    if (includeDetail) {
      const seqs = [...new Set(parsedEvents
        .filter((e) => e.event_type === "CA" && e.seq)
        .map((e) => String(e.seq)))]
        .slice(0, Math.max(0, Number(detailLimit) || 0));

      for (const seq of seqs) {
        const detailCmd = nextCmdid();
        const detailCid = nextCid();
        const detailRequest = {
          cmd: "query",
          service: "midata",
          param: {
            source: "research",
            index: "enQB_0_1_DescriptionCA",
            args: [seq],
            info: { cache_allow: true }
          }
        };
        const detailRecs = await ipotQueryRecords(
          ws,
          detailCmd,
          detailRequest,
          detailCid,
          { maxMs: 7000, emptyIdleMs: 1500 }
        );
        {
          const key = await saveCatalystRawSnapshot(env, {
            queryType: "ca_detail",
            cmdid: detailCmd,
            cid: detailCid,
            batchId,
            requestPayload: detailRequest,
            records: detailRecs,
            seq,
            syncedAt: new Date().toISOString()
          });
          if (key) rawKeys.push(key);
        }

        const d = detailRecs?.[0];
        if (!d || typeof d !== "object") continue;

        const descHtml = String(d.description || "");
        const descText = stripHtml(descHtml);
        await env.SSSAHAM_DB.prepare(
          `INSERT INTO catalyst_ca_detail
            (seq, sec, act_type, description_html, description_text, amount, ratio1, ratio2, cum_date, ex_date, rec_date, start_dist_date, end_dist_date, status, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(seq) DO UPDATE SET
             sec=excluded.sec,
             act_type=excluded.act_type,
             description_html=excluded.description_html,
             description_text=excluded.description_text,
             amount=excluded.amount,
             ratio1=excluded.ratio1,
             ratio2=excluded.ratio2,
             cum_date=excluded.cum_date,
             ex_date=excluded.ex_date,
             rec_date=excluded.rec_date,
             start_dist_date=excluded.start_dist_date,
             end_dist_date=excluded.end_dist_date,
             status=excluded.status,
             fetched_at=excluded.fetched_at`
        ).bind(
          String(d.seq || seq),
          d.sec || null,
          d.act_type || null,
          descHtml || null,
          descText || null,
          Number.isFinite(Number(d.amount)) ? Number(d.amount) : null,
          Number.isFinite(Number(d.ratio1)) ? Number(d.ratio1) : null,
          Number.isFinite(Number(d.ratio2)) ? Number(d.ratio2) : null,
          d.cum_date || null,
          d.ex_date || null,
          d.rec_date || null,
          d.start_dist_date || null,
          d.end_dist_date || null,
          d.status || null,
          nowIso
        ).run();

        await env.SSSAHAM_DB.prepare(
          `UPDATE catalyst_events SET detail_pending = 0, updated_at = ? WHERE seq = ?`
        ).bind(nowIso, String(d.seq || seq)).run();

        detailFetched++;
      }
    }

    return {
      ok: true,
      batch_id: batchId,
      from,
      to,
      total_calca_records: calcaRecordsRaw.length,
      parsed_events: parsedEvents.length,
      unique_symbols: symbols.length,
      upserted_events: upsertedEvents,
      detail_fetched: detailFetched,
      raw_snapshot_saved: rawKeys.length,
      raw_snapshot_keys: rawKeys.slice(0, 20),
      synced_at: nowIso,
      market_date: today
    };
  } finally {
    try { ws.close(1000, "done"); } catch {}
  }
}

function buildFeedEventFromAnalysis(symbol, analysisJson, provider, modelUsed, fromDate, toDate, cacheKey) {
  const recID = analysisJson?.kesimpulan_rekomendasi || {};
  const recEN = analysisJson?.recommendation || {};
  const rating = recID?.rating || recID?.rekomendasi || recEN?.rating || recEN?.position || "AI Update";
  const confidence = Number(recID?.confidence ?? recEN?.confidence ?? analysisJson?.meta?.confidence ?? 0) || 0;

  // ── Build engaging headline ──
  // Priority: 1) explicit headline field  2) executive_summary  3) smart_money assessment  4) first rationale
  let headline = "";
  if (typeof analysisJson?.headline === "string" && analysisJson.headline.trim()) {
    headline = analysisJson.headline.trim();
  } else if (Array.isArray(analysisJson?.executive_summary) && analysisJson.executive_summary.length > 0) {
    headline = String(analysisJson.executive_summary[0]).trim();
  } else if (typeof analysisJson?.smart_money?.assessment === "string" && analysisJson.smart_money.assessment.trim()) {
    headline = analysisJson.smart_money.assessment.trim();
  } else if (Array.isArray(recEN?.rationale) && recEN.rationale.length > 0) {
    headline = String(recEN.rationale[0]).trim();
  } else if (Array.isArray(recID?.alasan_rating) && recID.alasan_rating.length > 0) {
    headline = String(recID.alasan_rating[0]).trim();
  }
  // Truncate headline to ~120 chars for readability
  if (headline.length > 120) headline = headline.slice(0, 117) + "...";

  const title = headline
    ? `${symbol} ${rating}: ${headline}`
    : `${symbol} ${rating}`;

  // ── Body: executive summary (distinct from headline/rationale) ──
  let body = "Analisis terbaru tersedia.";
  // Prefer exec summary (string or array) as it's a distinct paragraph from rationale
  const execSumID = analysisJson?.ringkasan_eksekutif;
  const execSumEN = analysisJson?.executive_summary;
  if (typeof execSumID === "string" && execSumID.trim().length > 20) {
    body = execSumID.trim();
  } else if (typeof execSumEN === "string" && execSumEN.trim().length > 20) {
    body = execSumEN.trim();
  } else if (Array.isArray(execSumEN) && execSumEN.length > 0 && String(execSumEN[0]).trim().length > 20) {
    body = String(execSumEN[0]).trim();
  } else if (Array.isArray(execSumID) && execSumID.length > 0 && String(execSumID[0]).trim().length > 20) {
    body = String(execSumID[0]).trim();
  } else if (Array.isArray(recID?.alasan_rating) && recID.alasan_rating.length > 1) {
    body = String(recID.alasan_rating[1]);
  } else if (Array.isArray(recEN?.rationale) && recEN.rationale.length > 1) {
    body = String(recEN.rationale[1]);
  } else if (typeof analysisJson?.summary === "string" && analysisJson.summary.trim()) {
    body = analysisJson.summary.trim();
  }
  // Truncate body to ~250 chars for feed card readability
  if (body.length > 250) body = body.slice(0, 247) + "...";

  return {
    event_type: "ai_analysis",
    symbol,
    title,
    body,
    meta_json: JSON.stringify({
      provider,
      model: modelUsed,
      recommendation: rating,
      confidence,
      from: fromDate,
      to: toDate,
      cache_key: cacheKey
    })
  };
}

function slugifyFeedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function buildFeedDetailSlug(item) {
  const created = new Date(item?.created_at || Date.now());
  const y = created.getFullYear();
  const m = String(created.getMonth() + 1).padStart(2, "0");
  const d = String(created.getDate()).padStart(2, "0");
  const symbol = String(item?.symbol || "").toUpperCase() || "EMITEN";
  const title = String(item?.title || "update");
  const titleWithoutSymbol = title
    .replace(new RegExp(`^${symbol}\\s*`, "i"), "")
    .replace(/[•|:]/g, " ")
    .trim();
  const reco = slugifyFeedText(titleWithoutSymbol || "update") || "update";
  return `${y}-${m}-${d}-${symbol}-${reco}`;
}

function parseFeedMeta(metaJson) {
  try {
    return metaJson ? JSON.parse(metaJson) : null;
  } catch (_) {
    return null;
  }
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
      COUNT(*) as candle_count,
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

  const processedStatsMap = fromDateStr === toDateStr
    ? await fetchProcessedDailyStatsMap(env, fromDateStr)
    : new Map();
  let prevProcessedStatsMap = fromDateStr === toDateStr
    ? await fetchProcessedDailyStatsMap(env, prevTradingDayUTC(fromDateStr))
    : new Map();

  // FALLBACK: If processed/{prevDate}.json is empty (livetrade-taping-agregator
  // didn't write it), query D1 for previous trading day close prices directly.
  // This is the most reliable source — always available if footprint was taped.
  if (fromDateStr === toDateStr && prevProcessedStatsMap.size === 0) {
    const prevDateStr = prevTradingDayUTC(fromDateStr);
    const prevStartTs = new Date(`${prevDateStr}T02:00:00Z`).getTime();
    const prevEndTs   = new Date(`${prevDateStr}T09:00:00Z`).getTime();

    try {
      // Get the last close for each ticker on the previous trading day
      const { results: prevRows } = await env.SSSAHAM_DB.prepare(`
        SELECT ticker, close, MAX(time_key) as last_time
        FROM temp_footprint_consolidate
        WHERE time_key >= ? AND time_key <= ?
        GROUP BY ticker
      `).bind(prevStartTs, prevEndTs).all();

      if (prevRows && prevRows.length > 0) {
        const d1PrevMap = new Map();
        for (const row of prevRows) {
          const t = String(row.ticker || "").toUpperCase();
          const close = Number(row.close);
          if (t && Number.isFinite(close) && close > 0) {
            d1PrevMap.set(t, { close, open: null, vol: null, netVol: null, freq: null });
          }
        }
        if (d1PrevMap.size > 0) {
          console.log(`[RANGE] prevProcessedStats empty, D1 fallback loaded ${d1PrevMap.size} prev-day closes`);
          prevProcessedStatsMap = d1PrevMap;
        }
      }
    } catch (e) {
      console.warn(`[RANGE] D1 prev-day fallback failed:`, e?.message || e);
    }
  }

  // 5. Calculate Hybrid Scores
  const items = enriched.map(fp => {
    const t = String(fp?.ticker || "").toUpperCase();
    const stats = processedStatsMap.get(t);
    const prevStats = prevProcessedStatsMap.get(t);
    const freq = Number(stats?.freq);
    if (Number.isFinite(freq) && freq > 0) {
      fp.trade_freq = Math.round(freq);
    }
    const ctx = contextMap.get(fp.ticker) || {};
    const item = calculateHybridItem(fp, ctx);
    if (!item) return null;

    if (fromDateStr === toDateStr) {
      const candleCount = Number(fp?.candle_count || 0);
      const vol = Number(stats?.vol);
      const netVol = Number(stats?.netVol);
      // FIX: processed/{today}.json may not exist during intraday (written ~hourly
      // by livetrade-taping-agregator). Fall back to D1 footprint close which is always fresh.
      const curCloseFromStats = Number(stats?.close);
      const curCloseFromD1 = Number(fp?.close);
      const curClose = (Number.isFinite(curCloseFromStats) && curCloseFromStats > 0)
        ? curCloseFromStats
        : (Number.isFinite(curCloseFromD1) && curCloseFromD1 > 0 ? curCloseFromD1 : NaN);
      const prevClose = Number(prevStats?.close);

      if (candleCount < 30 && Number.isFinite(vol) && vol > 0 && Number.isFinite(netVol)) {
        const deltaPctFallback = (netVol / vol) * 100;
        item.d         = Number(deltaPctFallback.toFixed(2));
        item.net_delta = Number(netVol); // keep in sync
        item.cvd       = item.net_delta; // alias
      }

      if (candleCount < 30 && Number.isFinite(curClose) && Number.isFinite(prevClose) && prevClose > 0) {
        const momPctFallback = ((curClose - prevClose) / prevClose) * 100;
        item.p = Number(momPctFallback.toFixed(2));
      }

      if (candleCount < 30 && Number.isFinite(item.d) && Number.isFinite(item.p)) {
        item.div = Number((Math.abs(item.d) / (1 + Math.abs(item.p))).toFixed(2));
      }

      if (item.growth_pct == null && Number.isFinite(curClose) && Number.isFinite(prevClose) && prevClose > 0) {
        const growthFallback = ((curClose - prevClose) / prevClose) * 100;
        item.open_price = prevClose;
        item.recent_price = curClose;
        item.growth_pct = Number(growthFallback.toFixed(2));
      }

      // S2: ALWAYS override growth_pct with close-to-close (prevClose → curClose)
      // for consistency with standard stock app conventions (Google Finance, IPOT, etc.)
      if (Number.isFinite(curClose) && curClose > 0 && Number.isFinite(prevClose) && prevClose > 0) {
        item.open_price = prevClose;
        item.recent_price = curClose;
        item.growth_pct = Number((((curClose - prevClose) / prevClose) * 100).toFixed(2));
      }
    }

    return item;
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

  if (vol === 0 || open === 0 || close === 0) return null; // C3: guard close=0 → Mom%=-100%

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

  const candleCount = Number(footprint.candle_count || 0);
  const trueFreq = Number(footprint.trade_freq);
  const freqTx = Number.isFinite(trueFreq) && trueFreq > 0 ? Math.round(trueFreq) : candleCount;
  const reliableGrowth = candleCount >= 30;

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
    sig: signal,
    // Extended fields for frontend compatibility
    growth_pct: reliableGrowth ? parseFloat(pricePct.toFixed(2)) : null,
    freq_tx: freqTx,
    net_delta: Number(footprint.total_delta || 0), // B1: current-day net delta (NOT cumulative)
    cvd: Number(footprint.total_delta || 0),       // B1: alias for backward compat
    open_price: reliableGrowth ? open : null,
    recent_price: reliableGrowth ? close : null,
    notional_val: (close && delta !== 0) ? Math.round(delta * close * 100) : null, // B2: net value = delta(lot)×100(lembar/lot)×price — signed (+ buy, - sell), in Rp
    nv: (close && delta !== 0) ? Math.round(delta * close * 100) : null      // B2: alias for backward compat
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
  let brokersMap = Object.create(null);
  try {
    brokersMap = await getBrokersMapCached(env);
  } catch (e) {
    console.error("Error fetching brokers mapping:", e);
  }

  const start = new Date(startDate);
  let end = new Date(endDate);

  // ── EOD Availability Check: Data only available after 16:00 WIB (09:00 UTC) ──
  // If end date is today and before EOD cutoff, adjust to previous trading day
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];
  
  if (endStr === todayStr) {
    // WIB = UTC+7, so 16:00 WIB = 09:00 UTC
    const currentHourUTC = now.getUTCHours();
    const isBeforeEOD = currentHourUTC < 9; // Before 09:00 UTC = before 16:00 WIB
    
    if (isBeforeEOD) {
      // Before market close, yesterday is the latest available EOD data
      const prevTrading = prevTradingDayUTC(todayStr);
      console.log(`[EOD CHECK] Before 16:00 WIB, adjusting end date: ${endStr} -> ${prevTrading}`);
      end = new Date(prevTrading);
    }
  } else if (end > new Date(todayStr + 'T23:59:59Z')) {
    // End date is in the future, cap to today
    console.log(`[FUTURE DATE] Capping end date to today: ${endStr} -> ${todayStr}`);
    end = new Date(todayStr);
  }

  // Build weekday candidates first.
  // Holiday filtering is applied later with data-aware override:
  // if a date is marked holiday but has valid broker rows in R2, we still treat it as a trading day.
  const candidateDays = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    if (isWeekendUTC(dateStr)) continue;
    candidateDays.push(dateStr);
  }

  // ── Parallel R2 reads for all weekday candidates ──
  const r2Results = await Promise.all(
    candidateDays.map(async (dateStr) => {
      const keyLegacy = `${symbol}/${dateStr}.json`;
      const keyIpot = `${symbol}/ipot/${dateStr}.json`;
      try {
        let object = await env.RAW_BROKSUM.get(keyLegacy);
        if (!object) {
          object = await env.RAW_BROKSUM.get(keyIpot);
        }
        if (!object) return { dateStr, data: null };
        const fullOuter = await object.json();
        return { dateStr, data: fullOuter?.data || null };
      } catch (e) {
        return { dateStr, data: null };
      }
    })
  );

  // ── Live repair only for recent 3 days with missing data ──
  const nowMs = Date.now();
  const threeDaysMs = 3 * 86400000;
  const liveRepairPromises = [];
  for (const r of r2Results) {
    if (r.data && hasBrokerRows(r.data.broker_summary)) continue;
    // Only live-repair recent dates
    const dateMs = new Date(r.dateStr + "T12:00:00Z").getTime();
    if (nowMs - dateMs <= threeDaysMs) {
      liveRepairPromises.push(
        fetchLiveBrokerSnapshot(env, symbol, r.dateStr).then(repaired => {
          if (repaired && hasBrokerRows(repaired.broker_summary)) {
            r.data = {
              bandar_detector: repaired.bandar_detector,
              broker_summary: repaired.broker_summary
            };
          }
        }).catch(() => {})
      );
    }
  }
  if (liveRepairPromises.length > 0) {
    await Promise.all(liveRepairPromises);
  }

  const isRetail = (code) => {
    const b = brokersMap[code];
    if (!b) return false;
    const cat = (b.category || '').toLowerCase();
    return cat.includes('retail');
  };

  // ── Process all results ──
  for (const r of r2Results) {
    if (!r.data) continue;
    let bd = r.data.bandar_detector;
    let bs = r.data.broker_summary;

    if (!hasBrokerRows(bs)) continue;

    let foreignBuy = 0, foreignSell = 0;
    let retailBuy = 0, retailSell = 0;
    let localBuy = 0, localSell = 0;

    if (bs) {
      const process = (list, type) => {
        if (list && Array.isArray(list)) {
          list.forEach(b => {
            if (!b) return;
            const val = parseFloat(type === 'buy' ? b.bval : b.sval) || 0;
            // Use raw volume (untruncated shares) when available, then fall back to
            // reconstructing from value / avg_price, and lastly to lot-rounded blotv/slotv
            let vol = 0;
            if (type === 'buy') {
              const rawVol = parseFloat(b.buy_vol_raw);
              if (rawVol > 0) {
                vol = rawVol;
              } else {
                const avgPrice = parseFloat(b.netbs_buy_avg_price) || 0;
                vol = avgPrice > 0 ? val / avgPrice : parseFloat(b.blotv || b.blot * 100) || 0;
              }
            } else {
              const rawVol = parseFloat(b.sell_vol_raw);
              if (rawVol > 0) {
                vol = rawVol;
              } else {
                const avgPrice = parseFloat(b.netbs_sell_avg_price) || 0;
                vol = avgPrice > 0 ? val / avgPrice : parseFloat(b.slotv || b.slot * 100) || 0;
              }
            }
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
    results.push({ date: r.dateStr, data: summary });
  }

  // 6. On-Demand Backfill Trigger (If data incomplete or empty)
  // Data-aware expected trading day count:
  // - regular weekdays are expected trading days
  // - holiday dates are expected only if they actually have valid broker rows
  const expectedTradingDays = r2Results.reduce((acc, r) => {
    const hasRows = hasBrokerRows(r?.data?.broker_summary);
    const shouldCount = !isHolidayUTC(r.dateStr) || hasRows;
    return acc + (shouldCount ? 1 : 0);
  }, 0);
  const actualDays = results.length;
  const completeness = expectedTradingDays > 0 ? actualDays / expectedTradingDays : 0;
  const hasTradingExpectation = expectedTradingDays > 0;

  console.log(`[DATA CHECK] ${symbol}: Expected ${expectedTradingDays} trading days, Got ${actualDays}, Completeness: ${(completeness * 100).toFixed(1)}%`);

  // Trigger backfill if EMPTY or severely INCOMPLETE (< 25%)
  // Lowered threshold to 25% to handle holiday periods with missing data gracefully
  if (hasTradingExpectation && (results.length === 0 || completeness < 0.25)) { // Less than 25% complete
    if (env.BROKSUM_SERVICE) {
      const reason = results.length === 0 ? 'empty' : `incomplete (${(completeness * 100).toFixed(1)}%)`;
      console.log(`[BACKFILL] Triggering for ${symbol}: ${reason}`);

      // Fire & Forget
      const p = env.BROKSUM_SERVICE.fetch(
        `http://internal/auto-backfill?symbol=${encodeURIComponent(symbol)}&days=90&force=false&key=${env.INTERNAL_KEY || 'default'}`
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
    code: k, ...accBrokers[k],
    net: accBrokers[k].bval - accBrokers[k].sval,
    net_vol: accBrokers[k].bvol - accBrokers[k].svol
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
  const isIncomplete = hasTradingExpectation && completeness < 0.25;

  return {
    backfill_active: isIncomplete ? true : false,
    completeness: completeness,
    history: results,
    summary: {
      top_buyers: format('bval'),
      top_sellers: format('sval'),
      // Sort by net VOLUME (lot-based) to match IPOT ordering
      top_net_buyers: allNet.filter(b => b.net_vol > 0).sort((a, b) => b.net_vol - a.net_vol).slice(0, 20),
      top_net_sellers: allNet.filter(b => b.net_vol < 0).sort((a, b) => a.net_vol - b.net_vol).slice(0, 20),
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

async function resolveOrderflowWindow(env, now = new Date()) {
  if (!env?.SSSAHAM_DB) return null;

  const todayWindow = getTodayOrderflowWindow(now);
  const todayDateStr = todayWindow.dateStr;

  try {
    const todayRow = await env.SSSAHAM_DB.prepare(`
      SELECT
        COUNT(*) as candles,
        MIN(time_key) as first_ts,
        MAX(time_key) as last_ts
      FROM temp_footprint_consolidate
      WHERE date = ? AND time_key >= ? AND time_key <= ?
    `).bind(todayDateStr, todayWindow.startTs, todayWindow.endTs).first();

    const todayCandles = Number(todayRow?.candles || 0);
    if (todayCandles > 0) {
      return {
        dateStr: todayDateStr,
        startTs: todayWindow.startTs,
        endTs: todayWindow.endTs,
        isFallbackDay: false
      };
    }

    const fallbackRow = await env.SSSAHAM_DB.prepare(`
      SELECT
        date,
        MIN(time_key) as first_ts,
        MAX(time_key) as last_ts
      FROM temp_footprint_consolidate
      WHERE date <= ?
      GROUP BY date
      ORDER BY date DESC
      LIMIT 1
    `).bind(todayDateStr).first();

    if (!fallbackRow?.date) return null;

    const fbDate = String(fallbackRow.date);
    const fallbackStart = Number(fallbackRow.first_ts || 0) || new Date(`${fbDate}T02:00:00Z`).getTime();
    const fallbackEnd = Number(fallbackRow.last_ts || 0) || new Date(`${fbDate}T09:00:00Z`).getTime();

    return {
      dateStr: fbDate,
      startTs: fallbackStart,
      endTs: fallbackEnd,
      isFallbackDay: fbDate !== todayDateStr
    };
  } catch (err) {
    console.error("[orderflow] resolve window failed:", err);
    return null;
  }
}

async function fetchProcessedDailyFreqMap(env, dateStr) {
  const out = new Map();
  if (!env?.FOOTPRINT_BUCKET || !dateStr) return out;

  try {
    const obj = await env.FOOTPRINT_BUCKET.get(`processed/${dateStr}.json`);
    if (!obj) return out;

    const parsed = await obj.json();
    const items = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.items) ? parsed.items : []);

    for (const item of items) {
      const ticker = String(item?.kode || item?.t || "").toUpperCase();
      const freq = Number(item?.freq ?? item?.f);
      if (!ticker || !Number.isFinite(freq) || freq <= 0) continue;
      out.set(ticker, Math.round(freq));
    }
  } catch (err) {
    console.warn(`[orderflow] processed freq map failed for ${dateStr}:`, err?.message || err);
  }

  return out;
}

async function fetchProcessedDailyCloseMap(env, dateStr) {
  const out = new Map();
  if (!env?.FOOTPRINT_BUCKET || !dateStr) return out;

  try {
    const obj = await env.FOOTPRINT_BUCKET.get(`processed/${dateStr}.json`);
    if (!obj) return out;

    const parsed = await obj.json();
    const items = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.items) ? parsed.items : []);

    for (const item of items) {
      const ticker = String(item?.kode || item?.t || "").toUpperCase();
      const close = Number(item?.close ?? item?.c);
      if (!ticker || !Number.isFinite(close) || close <= 0) continue;
      out.set(ticker, close);
    }
  } catch (err) {
    console.warn(`[orderflow] processed close map failed for ${dateStr}:`, err?.message || err);
  }

  return out;
}

async function fetchProcessedDailyStatsMap(env, dateStr) {
  const out = new Map();
  if (!env?.FOOTPRINT_BUCKET || !dateStr) return out;

  try {
    const obj = await env.FOOTPRINT_BUCKET.get(`processed/${dateStr}.json`);
    if (!obj) return out;

    const parsed = await obj.json();
    const items = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.items) ? parsed.items : []);

    for (const item of items) {
      const ticker = String(item?.kode || item?.t || "").toUpperCase();
      const open = Number(item?.open ?? item?.o);
      const close = Number(item?.close ?? item?.c);
      const vol = Number(item?.vol ?? item?.v);
      const netVol = Number(item?.net_vol ?? item?.nv);
      const freq = Number(item?.freq ?? item?.f);
      if (!ticker) continue;

      out.set(ticker, {
        open: Number.isFinite(open) ? open : null,
        close: Number.isFinite(close) ? close : null,
        vol: Number.isFinite(vol) ? vol : null,
        netVol: Number.isFinite(netVol) ? netVol : null,
        freq: Number.isFinite(freq) ? freq : null,
      });
    }
  } catch (err) {
    console.warn(`[orderflow] processed stats map failed for ${dateStr}:`, err?.message || err);
  }

  return out;
}

/**
 * Fetch processed daily stats for N consecutive trading days in parallel.
 * Returns array where [0]=date (most recent), [1]=prev day, ..., [N-1]=oldest.
 */
async function fetchProcessedDailyStatsMaps(env, date, n = 20) {
  // Ensure dates[0] is always the most recent TRADING day, not a weekend/holiday.
  let startDate = date;
  {
    let sd = new Date(`${date}T12:00:00Z`);
    while ([0, 6].includes(sd.getUTCDay()) || IDX_HOLIDAYS.has(sd.toISOString().slice(0, 10))) {
      sd = new Date(sd.getTime() - 86400000);
    }
    startDate = sd.toISOString().slice(0, 10);
  }
  const dates = [startDate];
  let d = new Date(`${startDate}T12:00:00Z`);
  while (dates.length < n) {
    d = new Date(d.getTime() - 86400000);
    const ds = d.toISOString().slice(0, 10);
    if (![0, 6].includes(d.getUTCDay()) && !IDX_HOLIDAYS.has(ds)) {
      dates.push(ds);
    }
  }
  return Promise.all(dates.map(dt => fetchProcessedDailyStatsMap(env, dt)));
}

/**
 * Enrich items with multi-window CVD (2d/5d/10d/20d) and RVOL (2d/5d/10d/20d)
 * using 20 trading days of processed daily stats from R2.
 */
async function enrichWithMultiWindowCvdRvol(env, items, baseDate) {
  if (!items || !items.length || !baseDate) return;
  try {
    const maps = await fetchProcessedDailyStatsMaps(env, baseDate, 20);
    const loadedCount = maps.filter(m => m.size > 0).length;
    console.log(`[SUMMARY] Multi-window enrichment: ${loadedCount}/20 processed-stats maps loaded`);
    if (loadedCount === 0) return;

    for (const item of items) {
      const ticker = String(item.t || "").toUpperCase();
      if (!ticker) continue;

      // CVD windows: cumulative netVol
      let cvd_2d = 0, cvd_5d = 0, cvd_10d = 0, cvd_20d = 0;
      let has_2d = 0, has_5d = 0, has_10d = 0, has_20d = 0;
      for (let i = 0; i < 20; i++) {
        const nv = maps[i]?.get(ticker)?.netVol;
        if (!Number.isFinite(nv)) continue;
        if (i < 2)  { cvd_2d  += nv; has_2d++; }
        if (i < 5)  { cvd_5d  += nv; has_5d++; }
        if (i < 10) { cvd_10d += nv; has_10d++; }
        cvd_20d += nv; has_20d++;
      }
      item.cvd_2d  = has_2d  ? cvd_2d  : null;
      item.cvd_5d  = has_5d  ? cvd_5d  : null;
      item.cvd_10d = has_10d ? cvd_10d : null;
      item.cvd_20d = has_20d ? cvd_20d : null;

      // RVOL windows: todayVol / avg(D1..DW)
      const todayVol = item.v || maps[0]?.get(ticker)?.vol;
      if (Number.isFinite(todayVol) && todayVol > 0) {
        const calcRvol = (windowSize) => {
          let sum = 0, count = 0;
          for (let i = 1; i <= windowSize && i < 20; i++) {
            const v = maps[i]?.get(ticker)?.vol;
            if (Number.isFinite(v) && v > 0) { sum += v; count++; }
          }
          if (count === 0) return null;
          return parseFloat((todayVol / (sum / count)).toFixed(2));
        };
        item.rvol_2d  = calcRvol(2);
        item.rvol_5d  = calcRvol(5);
        item.rvol_10d = calcRvol(10);
        item.rvol_20d = calcRvol(20);
      }
    }
  } catch (e) {
    console.warn(`[SUMMARY] Multi-window enrichment failed:`, e?.message || e);
  }
}

function parsePositiveInt(value) {
  if (value === null || value === undefined) return null;
  const num = Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

async function fetchBroksumFrequency(env, symbol, dateStr) {
  if (!env?.RAW_BROKSUM || !symbol || !dateStr) return null;
  const key = `${String(symbol).toUpperCase()}/${dateStr}.json`;

  try {
    const obj = await env.RAW_BROKSUM.get(key);
    if (!obj) return null;
    const j = await obj.json();

    const parseFreqFromRawSummary = (rawLine) => {
      if (!rawLine || typeof rawLine !== "string") return null;
      const parts = rawLine.split("|");
      if (parts.length < 4) return null;
      // IPOT raw summary format:
      // CODE|TOTAL_VALUE|TOTAL_VOLUME_SHARES|TOTAL_FREQ|...
      return parsePositiveInt(parts[3]);
    };

    // Prefer exchange-level total transaction count first.
    // bandar_detector.frequency can be partial and much lower on some feeds.
    const totalFreqCandidates = [
      j?.data?.broker_summary?.stock_summary?.total_freq,
      j?.broker_summary?.stock_summary?.total_freq,
      j?.data?.stock_summary?.total_freq,
      j?.stock_summary?.total_freq,
      j?._meta?.summary?.total_freq,
      j?.data?._meta?.summary?.total_freq
    ];
    for (const c of totalFreqCandidates) {
      const n = parsePositiveInt(c);
      if (n) return n;
    }

    const rawSummaryCandidates = [
      j?._meta?.summary?.raw,
      j?.data?._meta?.summary?.raw,
      j?.data?.broker_summary?.stock_summary?.raw,
      j?.broker_summary?.stock_summary?.raw,
      j?.data?.stock_summary?.raw,
      j?.stock_summary?.raw
    ];
    for (const raw of rawSummaryCandidates) {
      const n = parseFreqFromRawSummary(raw);
      if (n) return n;
    }

    const fallbackCandidates = [
      j?.data?.bandar_detector?.frequency,
      j?.bandar_detector?.frequency
    ];
    for (const c of fallbackCandidates) {
      const n = parsePositiveInt(c);
      if (n) return n;
    }

    return null;
  } catch (err) {
    console.warn(`[orderflow] broksum freq read failed for ${key}:`, err?.message || err);
    return null;
  }
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
  const window = await resolveOrderflowWindow(env);
  if (!window) return null;
  const { dateStr, startTs, endTs, isFallbackDay } = window;
  const processedStatsMap = await fetchProcessedDailyStatsMap(env, dateStr);
  const prevDateStr = prevTradingDayUTC(dateStr);
  const prevProcessedStatsMap = await fetchProcessedDailyStatsMap(env, prevDateStr);
  const broksumFreq = await fetchBroksumFrequency(env, normalizedSymbol, dateStr);

  try {
    const aggregate = await env.SSSAHAM_DB.prepare(`
      SELECT 
        SUM(vol) as total_vol,
        SUM(delta) as total_delta,
        COUNT(*) as candle_count,
        MIN(time_key) as first_ts,
        MAX(time_key) as last_ts,
        MAX(high) as high,
        MIN(low) as low
      FROM temp_footprint_consolidate
      WHERE ticker = ? AND date = ? AND time_key >= ? AND time_key <= ?
    `).bind(normalizedSymbol, dateStr, startTs, endTs).first();

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
    const growthPctRaw = open > 0 ? ((close - open) / open) * 100 : null;
    const candleCount = Number(aggregate.candle_count || 0);
    const stats = processedStatsMap.get(normalizedSymbol);
    const prevStats = prevProcessedStatsMap.get(normalizedSymbol);
    const statsFreq = Number(stats?.freq);
    // S3: Use explicit priority instead of Math.max across different-unit sources.
    // broksumFreq = exchange total transaction count (IPOT); statsFreq = processed stats freq;
    // candleCount = D1 1-min candle count (different unit, fallback only).
    const freqTx = (Number.isFinite(broksumFreq) && broksumFreq > 0)
      ? Math.round(broksumFreq)
      : (Number.isFinite(statsFreq) && statsFreq > 0)
        ? Math.round(statsFreq)
        : candleCount;
    const reliableGrowth = candleCount >= 30;

    let openPriceOut = reliableGrowth ? open : null;
    let recentPriceOut = reliableGrowth ? close : null;
    let growthPctOut = (reliableGrowth && Number.isFinite(growthPctRaw)) ? Number(growthPctRaw.toFixed(2)) : null;
    let deltaPctOut = hybrid.d;
    let momPctOut = hybrid.p;
    let absorbOut = hybrid.div;
    let cvdOut = Number(aggregate.total_delta || 0);

    if (!reliableGrowth) {
      const vol = Number(stats?.vol);
      const netVol = Number(stats?.netVol);
      const curClose = Number(stats?.close);
      const prevClose = Number(prevStats?.close);

      if (Number.isFinite(vol) && vol > 0 && Number.isFinite(netVol)) {
        deltaPctOut = Number(((netVol / vol) * 100).toFixed(2));
        cvdOut = Number(netVol);
      }

      if (Number.isFinite(curClose) && Number.isFinite(prevClose) && prevClose > 0) {
        const pct = ((curClose - prevClose) / prevClose) * 100;
        momPctOut = Number(pct.toFixed(2));
        openPriceOut = prevClose;
        recentPriceOut = curClose;
        growthPctOut = Number(pct.toFixed(2));
      }

      if (Number.isFinite(deltaPctOut) && Number.isFinite(momPctOut)) {
        absorbOut = Number((Math.abs(deltaPctOut) / (1 + Math.abs(momPctOut))).toFixed(2));
      }
    }

    // ALWAYS override growth_pct with close-to-close (prevClose → curClose)
    // for consistency with standard stock app conventions (Google Finance, IPOT, etc.)
    {
      const curClose = Number(stats?.close);
      const prevClose = Number(prevStats?.close);
      if (Number.isFinite(curClose) && curClose > 0 && Number.isFinite(prevClose) && prevClose > 0) {
        openPriceOut = prevClose;
        recentPriceOut = curClose;
        growthPctOut = Number((((curClose - prevClose) / prevClose) * 100).toFixed(2));
      }
    }

    return {
      ticker: normalizedSymbol,
      price: close,
      open_price: openPriceOut,
      recent_price: recentPriceOut,
      growth_pct: growthPctOut,
      freq_tx: freqTx,
      delta_pct: deltaPctOut,
      price_pct: momPctOut,
      mom_pct: momPctOut,
      absorb: absorbOut,
      cvd: cvdOut,
      net_value: netValue,
      volume: hybrid.v,
      range: hybrid.r,
      score: hybrid.sc,
      signal: hybrid.sig,
      quadrant: mapQuadrant(deltaPctOut, momPctOut),
      context_state: hybrid.ctx_st,
      context_z: hybrid.ctx_net,
      trading_date: dateStr,
      is_fallback_day: !!isFallbackDay,
      snapshot_at: snapshotAt,
      generated_at: new Date().toISOString(),
      source: "d1"
    };
  } catch (err) {
    console.error("[orderflow] snapshot failed:", err);
    return null;
  }
}

async function getOrderflowSnapshotMap(env, requestedSymbols = null) {
  if (!env?.SSSAHAM_DB) return {};

  const window = await resolveOrderflowWindow(env);
  if (!window) return {};
  const { dateStr, startTs, endTs, isFallbackDay } = window;
  const processedStatsMap = await fetchProcessedDailyStatsMap(env, dateStr);
  const prevDateStr = prevTradingDayUTC(dateStr);
  const prevProcessedStatsMap = await fetchProcessedDailyStatsMap(env, prevDateStr);
  const normalizedSymbols = Array.isArray(requestedSymbols)
    ? [...new Set(
      requestedSymbols
        .map(symbol => String(symbol || "").trim().toUpperCase())
        .filter(symbol => /^[A-Z]{2,6}$/.test(symbol))
    )]
    : [];
  const symbolFilterSet = normalizedSymbols.length ? new Set(normalizedSymbols) : null;
  const QUERY_SYMBOL_CHUNK = 40;

  try {
    let rows = [];
    if (normalizedSymbols.length) {
      for (let i = 0; i < normalizedSymbols.length; i += QUERY_SYMBOL_CHUNK) {
        const chunk = normalizedSymbols.slice(i, i + QUERY_SYMBOL_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const { results: chunkRows = [] } = await env.SSSAHAM_DB.prepare(`
          SELECT ticker, time_key, open, close, vol, delta, high, low
          FROM temp_footprint_consolidate
          WHERE date = ? AND time_key >= ? AND time_key <= ? AND ticker IN (${placeholders})
          ORDER BY ticker ASC, time_key ASC
        `).bind(dateStr, startTs, endTs, ...chunk).all();
        rows.push(...chunkRows);
      }
      rows.sort((a, b) => {
        const ta = String(a?.ticker || "");
        const tb = String(b?.ticker || "");
        if (ta === tb) return Number(a?.time_key || 0) - Number(b?.time_key || 0);
        return ta.localeCompare(tb);
      });
    } else {
      const { results: allRows = [] } = await env.SSSAHAM_DB.prepare(`
        SELECT ticker, time_key, open, close, vol, delta, high, low
        FROM temp_footprint_consolidate
        WHERE date = ? AND time_key >= ? AND time_key <= ?
        ORDER BY ticker ASC, time_key ASC
      `).bind(dateStr, startTs, endTs).all();
      rows = allRows;
    }

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
          freq_tx: 0,
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
      agg.freq_tx = Number(agg.freq_tx || 0) + 1;
      if (ts && (!agg.first_ts || ts < agg.first_ts)) agg.first_ts = ts;
      if (ts && (!agg.last_ts || ts > agg.last_ts)) agg.last_ts = ts;
    }

    const ctxMap = new Map();
    try {
      let ctxRows = [];
      if (normalizedSymbols.length) {
        for (let i = 0; i < normalizedSymbols.length; i += QUERY_SYMBOL_CHUNK) {
          const chunk = normalizedSymbols.slice(i, i + QUERY_SYMBOL_CHUNK);
          const placeholders = chunk.map(() => "?").join(",");
          const { results: ctxChunkRows = [] } = await env.SSSAHAM_DB.prepare(`
            SELECT d.ticker, d.state as hist_state, d.z_ngr as hist_z_ngr
            FROM daily_features d
            INNER JOIN (
              SELECT ticker, MAX(date) as max_date
              FROM daily_features
              WHERE date < ? AND ticker IN (${placeholders})
              GROUP BY ticker
            ) m
              ON d.ticker = m.ticker AND d.date = m.max_date
          `).bind(dateStr, ...chunk).all();
          ctxRows.push(...ctxChunkRows);
        }
      } else {
        const { results: allCtxRows = [] } = await env.SSSAHAM_DB.prepare(`
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
        ctxRows = allCtxRows;
      }

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
      if (symbolFilterSet && !symbolFilterSet.has(ticker)) continue;
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
      const growthPctRaw = agg.open > 0 ? ((agg.close - agg.open) / agg.open) * 100 : null;
      const candleCount = Number(agg.freq_tx || 0);
      const stats = processedStatsMap.get(ticker);
      const prevStats = prevProcessedStatsMap.get(ticker);
      const freqTx = Number(stats?.freq ?? candleCount);
      const reliableGrowth = candleCount >= 30;

      let openPriceOut = reliableGrowth ? agg.open : null;
      let recentPriceOut = reliableGrowth ? agg.close : null;
      let growthPctOut = (reliableGrowth && Number.isFinite(growthPctRaw)) ? Number(growthPctRaw.toFixed(2)) : null;
      let deltaPctOut = hybrid.d;
      let momPctOut = hybrid.p;
      let absorbOut = hybrid.div;
      let cvdOut = Number(agg.total_delta || 0);

      if (!reliableGrowth) {
        const vol = Number(stats?.vol);
        const netVol = Number(stats?.netVol);
        const curClose = Number(stats?.close);
        const prevClose = Number(prevStats?.close);

        if (Number.isFinite(vol) && vol > 0 && Number.isFinite(netVol)) {
          deltaPctOut = Number(((netVol / vol) * 100).toFixed(2));
          cvdOut = Number(netVol);
        }

        if (Number.isFinite(curClose) && Number.isFinite(prevClose) && prevClose > 0) {
          const pct = ((curClose - prevClose) / prevClose) * 100;
          openPriceOut = prevClose;
          recentPriceOut = curClose;
          growthPctOut = Number(pct.toFixed(2));
          momPctOut = Number(pct.toFixed(2));
        }

        if (Number.isFinite(deltaPctOut) && Number.isFinite(momPctOut)) {
          absorbOut = Number((Math.abs(deltaPctOut) / (1 + Math.abs(momPctOut))).toFixed(2));
        }
      }

      // ALWAYS override growth_pct with close-to-close (prevClose → curClose)
      // for consistency with standard stock app conventions (Google Finance, IPOT, etc.)
      {
        const curClose = Number(stats?.close);
        const prevClose = Number(prevStats?.close);
        if (Number.isFinite(curClose) && curClose > 0 && Number.isFinite(prevClose) && prevClose > 0) {
          openPriceOut = prevClose;
          recentPriceOut = curClose;
          growthPctOut = Number((((curClose - prevClose) / prevClose) * 100).toFixed(2));
        }
      }

      out[ticker] = {
        ticker,
        price: agg.close,
        open_price: openPriceOut,
        recent_price: recentPriceOut,
        growth_pct: growthPctOut,
        freq_tx: freqTx,
        delta_pct: deltaPctOut,
        price_pct: momPctOut,
        mom_pct: momPctOut,
        absorb: absorbOut,
        cvd: cvdOut,
        net_value: netValue,
        volume: hybrid.v,
        range: hybrid.r,
        score: hybrid.sc,
        signal: hybrid.sig,
        quadrant: mapQuadrant(deltaPctOut, momPctOut),
        context_state: hybrid.ctx_st,
        context_z: hybrid.ctx_net,
        trading_date: dateStr,
        is_fallback_day: !!isFallbackDay,
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

      // ── Phase 1: POST /ma-watchlist-sync ──
      // Browser pipeline posts dynamic Most Active roster for livetrade-taping to subscribe OB2.
      // UNION MERGE: accumulates all symbols seen today so dropped roster members
      // keep their OB2 subscriptions alive for the full trading day.
      // Stored in KV with 5-minute TTL so stale watchlists auto-expire.
      if (url.pathname === "/ma-watchlist-sync" && req.method === "POST") {
        try {
          const body = await req.json();
          const symbols = Array.isArray(body?.symbols) ? body.symbols : [];
          const incoming = [...new Set(
            symbols.map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z]{2,6}$/.test(s))
          )];

          if (!incoming.length) {
            return json({ ok: false, error: "No valid symbols provided" }, 400);
          }

          // Determine today's WIB date for day-boundary reset
          const todayWib = getRecentWibDates(1)[0];

          // Read existing KV and merge (union) if same trading day
          let unionSet = new Set(incoming);
          let mergedCount = 0;
          if (env.MOST_ACTIVE_KV) {
            try {
              const existing = await env.MOST_ACTIVE_KV.get("most-active:watchlist");
              if (existing) {
                const data = JSON.parse(existing);
                if (data.date === todayWib && Array.isArray(data.symbols)) {
                  for (const s of data.symbols) {
                    if (/^[A-Z]{2,6}$/.test(s)) unionSet.add(s);
                  }
                  mergedCount = unionSet.size - incoming.length;
                }
              }
            } catch { /* ignore parse errors, start fresh */ }
          }

          const payload = {
            symbols: [...unionSet].slice(0, 200), // Higher cap for union accumulation
            ts: Date.now(),
            date: todayWib,
            source: String(body?.source || "browser"),
          };

          // KV write with 5 minute TTL (auto-expire if browser disconnects)
          if (env.MOST_ACTIVE_KV) {
            await env.MOST_ACTIVE_KV.put(
              "most-active:watchlist",
              JSON.stringify(payload),
              { expirationTtl: 300 } // 5 minutes
            );
          } else {
            console.warn("[/ma-watchlist-sync] MOST_ACTIVE_KV binding not found");
          }

          return json({
            ok: true,
            symbols_count: payload.symbols.length,
            incoming_count: incoming.length,
            merged_historical: mergedCount,
            ttl_seconds: 300,
            date: todayWib,
            ts: payload.ts,
          });
        } catch (err) {
          console.error("[/ma-watchlist-sync] failed", err);
          return json({ ok: false, error: err?.message || "sync_failed" }, 500);
        }
      }

      // ── GET /prev-close ──
      // Returns current close + previous trading day close prices from yfinance R2 / D1.
      // Query: ?symbols=BBRI,TLKM,...  (comma-separated, max 60)
      // Returns per symbol: { close, close_date, prev_close, prev_date }
      // Used by frontend for LAST price display and accurate CHG% computation.
      if (url.pathname === "/prev-close" && req.method === "GET") {
        try {
          const symbolsRaw = String(url.searchParams.get("symbols") || "").trim().toUpperCase();
          if (!symbolsRaw) {
            return json({ ok: false, error: "symbols query param required (comma-separated)" }, 400);
          }
          const symbols = [...new Set(
            symbolsRaw.split(",").map(s => s.trim()).filter(s => /^[A-Z]{2,6}$/.test(s))
          )].slice(0, 60);

          // Determine recent dates (WIB) — up to 7 days back for weekends/holidays
          const datesToTry = getRecentWibDates(7);
          const result = {};
          const missing = [];

          // Phase 1: yfinance R2 — read monthly files (1-2 GETs per symbol instead of 3-7)
          // Monthly key: yfinance/{CODE}/1d/{YYYY-MM}.json contains all daily candles for that month
          const tradingDatesToTry = datesToTry.filter(d => !isNonTradingDayUTC(d));
          const monthsNeeded = [...new Set(tradingDatesToTry.map(d => d.slice(0, 7)))]; // e.g. ["2026-03","2026-02"]

          await Promise.all(symbols.map(async (symbol) => {
            const entry = { close: null, close_date: null, prev_close: null, prev_date: null };

            // Collect all candles from relevant monthly files (usually 1-2 months)
            const allCandles = new Map(); // date → candle
            for (const month of monthsNeeded) {
              if (entry.close !== null && entry.prev_close !== null) break;
              try {
                const key = `yfinance/${symbol}/1d/${month}.json`;
                const obj = await env.FOOTPRINT_BUCKET.get(key);
                if (!obj) {
                  // Fallback: try legacy daily files for this month's dates
                  for (const date of tradingDatesToTry.filter(d => d.startsWith(month))) {
                    const legacyKey = `yfinance/${symbol}/1d/${date}.json`;
                    const legacyObj = await env.FOOTPRINT_BUCKET.get(legacyKey);
                    if (!legacyObj) continue;
                    try {
                      const ld = JSON.parse(await legacyObj.text());
                      for (const c of (ld?.candles || [])) {
                        if (c?.date && !allCandles.has(c.date)) allCandles.set(c.date, c);
                      }
                    } catch { /* skip */ }
                  }
                  continue;
                }
                const data = JSON.parse(await obj.text());
                for (const c of (data?.candles || [])) {
                  if (c?.date && !allCandles.has(c.date)) allCandles.set(c.date, c);
                }
              } catch { /* skip */ }
            }

            // Walk through dates newest-first, find close + prev_close
            for (const date of tradingDatesToTry) {
              const candle = allCandles.get(date);
              if (!candle) continue;
              const price = Number(candle.close);
              if (!Number.isFinite(price) || price <= 0) continue;

              if (entry.close === null) {
                entry.close = price;
                entry.close_date = date;
              } else if (entry.prev_close === null && date !== entry.close_date) {
                entry.prev_close = price;
                entry.prev_date = date;
                break;
              }
            }

            if (entry.close !== null || entry.prev_close !== null) {
              result[symbol] = entry;
              if (!entry.prev_close && entry.close) {
                entry.prev_close = entry.close;
                entry.prev_date = entry.close_date;
                entry.close = null;
                entry.close_date = null;
              }
            } else {
              missing.push(symbol);
            }
          }));

          // Phase 2: D1 FALLBACK for symbols missing from yfinance R2
          // Also enriches symbols that only got one of the two prices from yfinance
          if (missing.length > 0 || Object.values(result).some(e => !e.close || !e.prev_close)) {
            try {
              const tradingDates = getRecentWibDates(7).filter(d => !isNonTradingDayUTC(d));

              for (const tryDate of tradingDates) {
                // Determine which symbols need data for this date
                const needClose = [];
                const needPrev = [];
                for (const sym of symbols) {
                  const e = result[sym];
                  if (!e) { needClose.push(sym); needPrev.push(sym); continue; }
                  if (!e.close) needClose.push(sym);
                  if (!e.prev_close) needPrev.push(sym);
                }
                const needSymbols = [...new Set([...needClose, ...needPrev])];
                if (needSymbols.length === 0) break;

                const startTs = new Date(`${tryDate}T02:00:00Z`).getTime();
                const endTs   = new Date(`${tryDate}T09:00:00Z`).getTime();

                const { results: d1Rows } = await env.SSSAHAM_DB.prepare(`
                  SELECT ticker, close, open, MAX(close) as high, MIN(close) as low
                  FROM temp_footprint_consolidate
                  WHERE time_key >= ? AND time_key <= ?
                  GROUP BY ticker
                `).bind(startTs, endTs).all();

                if (d1Rows && d1Rows.length > 0) {
                  const d1Map = new Map(d1Rows.map(r => [String(r.ticker || '').toUpperCase(), r]));
                  for (const sym of needSymbols) {
                    const row = d1Map.get(sym);
                    if (!row || !(Number(row.close) > 0)) continue;
                    const price = Number(row.close);

                    if (!result[sym]) {
                      result[sym] = { close: price, close_date: tryDate, prev_close: null, prev_date: null, source: 'd1_fallback' };
                    } else {
                      const e = result[sym];
                      if (!e.close) {
                        e.close = price;
                        e.close_date = tryDate;
                        if (!e.source) e.source = 'd1_partial';
                      } else if (!e.prev_close && tryDate !== e.close_date) {
                        e.prev_close = price;
                        e.prev_date = tryDate;
                        if (!e.source) e.source = 'd1_partial';
                      }
                    }
                  }
                }
              }
              // Update missing list
              missing.length = 0;
              for (const s of symbols) { if (!result[s]) missing.push(s); }
            } catch (e) {
              console.warn('[/prev-close] D1 fallback failed:', e?.message || e);
            }
          }

          return json({
            ok: true,
            data: result,
            coverage: { requested: symbols.length, found: Object.keys(result).length, missing },
            ts: Date.now(),
          });
        } catch (err) {
          console.error("[/prev-close] failed", err);
          return json({ ok: false, error: err?.message || "prev_close_failed" }, 500);
        }
      }

      // ── Phase 2: GET /ob2-seed ──
      // Returns recent OB2 snapshots from single R2 snapshot file for cold-start seeding of BSS/ATS.
      // Query: ?symbols=BBRI,SKBM,...
      if (url.pathname === "/ob2-seed" && req.method === "GET") {
        try {
          const symbolsRaw = String(url.searchParams.get("symbols") || "").trim().toUpperCase();
          if (!symbolsRaw) {
            return json({ ok: false, error: "symbols query param required (comma-separated)" }, 400);
          }
          const symbols = [...new Set(
            symbolsRaw.split(",").map(s => s.trim()).filter(s => /^[A-Z]{2,6}$/.test(s))
          )].slice(0, 50); // Increased cap since it's a single R2 read now

          // Single R2 GET — snapshot contains all symbols with last 3 snapshots each
          const obj = await env.FOOTPRINT_BUCKET.get('ob2/snapshot/latest.json');
          if (!obj) {
            return json({
              ok: true,
              seeds: {},
              coverage: { requested: symbols.length, found: 0, missing: symbols },
              ts: Date.now(),
              source: 'snapshot_v2',
            });
          }

          const data = await obj.json();
          const allSymbols = data?.symbols || {};
          const seeds = {};
          const missing = [];

          for (const sym of symbols) {
            const snaps = allSymbols[sym];
            if (Array.isArray(snaps) && snaps.length > 0) {
              seeds[sym] = snaps;
            } else {
              missing.push(sym);
            }
          }

          return json({
            ok: true,
            seeds,
            coverage: {
              requested: symbols.length,
              found: Object.keys(seeds).length,
              missing,
            },
            ts: data?.ts || Date.now(),
            source: 'snapshot_v2',
          });
        } catch (err) {
          console.error("[/ob2-seed] failed", err);
          return json({ ok: false, error: err?.message || "ob2_seed_failed" }, 500);
        }
      }

      // 0.a GET /ws-token
      // Expose cached IPOT appsession token for frontend/edge producers.
      // Cache behavior (inside fetchIpotAppSession):
      // - primary: 10 minutes
      // - backup: 6 hours stale-if-error
      if (url.pathname === "/ws-token" && req.method === "GET") {
        try {
          const forceRefresh = ["1", "true", "yes"].includes(
            String(url.searchParams.get("refresh") || "").toLowerCase()
          );

          if (forceRefresh) {
            await clearIpotAppSession(env);
          }

          const token = await fetchIpotAppSession(env);
          const masked = token ? `${String(token).slice(0, 6)}...${String(token).slice(-4)}` : null;
          return json({
            ok: true,
            token,
            token_masked: masked,
            ttl_seconds: 600,
            source: forceRefresh ? "network_refresh" : "cache_or_network",
            ts_unix_ms: Date.now()
          });
        } catch (err) {
          console.error("[/ws-token] failed", err);
          return json({ ok: false, error: err?.message || "failed_to_fetch_ws_token" }, 500);
        }
      }

      // 0.b GET /ob2/snapshot15s/latest
      // Read latest OB2 snapshot for a single symbol from unified snapshot file.
      // Query:
      // - symbol=BBRI (required)
      // - tail=1..3 (optional, max 3 since ring buffer keeps last 3)
      if (url.pathname === "/ob2/snapshot15s/latest" && req.method === "GET") {
        try {
          const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
          if (!symbol) {
            return json({ ok: false, error: "symbol is required" }, 400);
          }

          const tail = Math.max(1, Math.min(3, Number(url.searchParams.get("tail") || "1") || 1));

          const obj = await env.FOOTPRINT_BUCKET.get('ob2/snapshot/latest.json');
          if (!obj) {
            return json({ ok: true, symbol, found: false, message: "no snapshot file found" });
          }

          const data = await obj.json();
          const snaps = data?.symbols?.[symbol];

          if (!Array.isArray(snaps) || !snaps.length) {
            return json({ ok: true, symbol, found: false, message: "symbol not in snapshot" });
          }

          return json({
            ok: true,
            symbol,
            found: true,
            count: Math.min(tail, snaps.length),
            items: snaps.slice(-tail),
            snapshot_ts: data?.ts,
            source: 'snapshot_v2',
          });
        } catch (err) {
          console.error("[/ob2/snapshot15s/latest] failed", err);
          return json({ ok: false, error: err?.message || "failed_to_read_ob2_snapshot" }, 500);
        }
      }

      // 0.c GET /internal/e2e-most-active-check
      // quick readiness probe: ws token + latest ob2 snapshot
      if (url.pathname === "/internal/e2e-most-active-check" && req.method === "GET") {
        try {
          const symbol = String(url.searchParams.get("symbol") || "BBRI").trim().toUpperCase();

          let tokenOk = false;
          let tokenErr = null;
          try {
            const token = await fetchIpotAppSession(env);
            tokenOk = Boolean(token);
          } catch (e) {
            tokenErr = e?.message || String(e);
          }

          // Check unified snapshot file
          let obFound = false;
          let obSymbolFound = false;
          const head = await env.FOOTPRINT_BUCKET.head('ob2/snapshot/latest.json');
          if (head) {
            obFound = true;
            // Optionally check if symbol is in the snapshot
            try {
              const obj = await env.FOOTPRINT_BUCKET.get('ob2/snapshot/latest.json');
              if (obj) {
                const data = await obj.json();
                obSymbolFound = Boolean(data?.symbols?.[symbol]?.length);
              }
            } catch { /* ignore */ }
          }

          return json({
            ok: tokenOk,
            checklist: {
              ws_token_available: tokenOk,
              ws_token_error: tokenErr,
              ob2_snapshot_available: obFound,
              ob2_symbol_found: obSymbolFound,
            },
            symbol,
            ts_unix_ms: Date.now(),
          }, tokenOk ? 200 : 503);
        } catch (err) {
          console.error("[/internal/e2e-most-active-check] failed", err);
          return json({ ok: false, error: err?.message || "e2e_check_failed" }, 500);
        }
      }

      // ── GET /sector/cvd ────────────────────────────────────────────────
      // Returns CVD (from sector-scrapper TradedSummary levels) for all
      // symbols across all IDX sectors. Reads sector snapshot JONLs from
      // the shared FOOTPRINT_BUCKET (R2). One call enriches the entire roster.
      // CVD = Σ(b_lot - s_lot) from TradedSummary price levels.
      //
      // R2 path: sector/{SECTOR}/{YYYY}/{MM}/{DD}/latest.jsonl  (new snapshot)
      // Fallback: sector/{SECTOR}/{YYYY}/{MM}/{DD}.jsonl         (legacy aggregate)
      if (url.pathname === "/sector/cvd" && req.method === "GET") {
        const SECTOR_LIST = [
          "IDXBASIC","IDXENERGY","IDXINDUST","IDXNONCYC","IDXCYCLIC",
          "IDXHEALTH","IDXFINANCE","IDXPROPERT","IDXTECHNO","IDXINFRA","IDXTRANS"
        ];
        // Use WIB date
        const _now = new Date();
        const _wib = new Date(_now.getTime() + 7 * 60 * 60 * 1000);
        const wibDate = url.searchParams.get("date") ||
          `${_wib.getUTCFullYear()}-${String(_wib.getUTCMonth()+1).padStart(2,"0")}-${String(_wib.getUTCDate()).padStart(2,"0")}`;
        const [yyyy, mm, dd] = wibDate.split("-");

        try {
          const symbolMap = {};

          // Read all sector snapshots in parallel (new path first, fallback to legacy)
          await Promise.all(SECTOR_LIST.map(async (sector) => {
            const newKey    = `sector/${sector}/${yyyy}/${mm}/${dd}/latest.jsonl`;
            const legacyKey = `sector/${sector}/${yyyy}/${mm}/${dd}.jsonl`;

            let text = null;
            for (const key of [newKey, legacyKey]) {
              try {
                const obj = await env.FOOTPRINT_BUCKET.get(key);
                if (obj) { text = await obj.text(); break; }
              } catch { /* try next */ }
            }
            if (!text) return;

            // Parse records — in new snapshot format each line IS the latest record per symbol
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                const rec = JSON.parse(line);
                const sym = String(rec.symbol || "").toUpperCase();
                if (!sym || symbolMap[sym]) continue; // first sector wins

                // CVD from pre-computed field or levels fallback
                let cvd_lot = rec.cvd_lot ?? null;
                if (cvd_lot === null && Array.isArray(rec.levels) && rec.levels.length > 0) {
                  cvd_lot = rec.levels.reduce((sum, lv) => {
                    const bl = Number(lv.b_lot || 0);
                    const sl = Number(lv.s_lot || 0);
                    return sum + (Number.isFinite(bl) ? bl : 0) - (Number.isFinite(sl) ? sl : 0);
                  }, 0);
                }

                symbolMap[sym] = {
                  sector,
                  cvd_lot,
                  freq_tx: rec.freq_tx ?? null,
                  price_last: rec.price_last ?? null,
                };
              } catch { /* skip */ }
            }
          }));

          return json({
            ok: true,
            date: wibDate,
            count: Object.keys(symbolMap).length,
            symbols: symbolMap
          }, 200, { "Cache-Control": "public, max-age=60" });
        } catch (e) {
          return json({ ok: false, error: e?.message || String(e) }, 500);
        }
      }

      // 0. GET /footprint/summary (Hybrid Bubble Chart - Static Live)
      if (url.pathname === "/footprint/summary" && req.method === "GET") {
        // WEEKEND FALLBACK: Check if today is weekend and fallback to last trading day's summary
        // WEEKEND FALLBACK (UTC): check weekend by UTC date string
        const now = new Date();
        const todayUTC = now.toISOString().slice(0, 10);
        const isWeekend = isNonTradingDayUTC(todayUTC);


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

        // v3.1+ summaries include ZSCORE items enriched with CVD/RVOL windows.
        // Don't discard them just because withFootprint=0 — they have valuable data.
        // Only fallback if the summary is truly empty or has very few items.
        const hasEnrichedData = (cachedData?.items?.length || 0) > 100 &&
            cachedData?.version?.includes('v3.1');
        const needsFallback = isEmpty || (isWeekend && !hasEnrichedData) || (isZscoreOnlySummary && !hasEnrichedData);

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
            const tryDateStr = tryDate.toISOString().split("T")[0];
            // Skip weekends & holidays
            if (isNonTradingDayUTC(tryDateStr)) continue;

            console.log(`[SUMMARY] Trying fallback date: ${tryDateStr} (${daysBack} days back)`);

            try {
              const rangeData = await calculateFootprintRange(env, tryDateStr, tryDateStr);
              if (rangeData && rangeData.items && rangeData.items.length > 0) {
                // Enrich with multi-window CVD (2d/5d/10d/20d) and RVOL (2d/5d/10d/20d)
                await enrichWithMultiWindowCvdRvol(env, rangeData.items, tryDateStr);
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
        headers.set("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
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

        // NON-TRADING DAY FALLBACK: If requested date is weekend or holiday, fallback to previous trading day
        if (isNonTradingDayUTC(dateStr)) {
          const fallback = prevTradingDayUTC(dateStr);
          console.log(`[API] Non-trading day fallback: ${dateStr} -> ${fallback}`);
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
          let brokersMap = Object.create(null);

          // Fetch brokers mapping
          try {
            brokersMap = await getBrokersMapCached(env);
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
          const includeOrderflow = url.searchParams.get("include_orderflow") !== "false";
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
          if (includeOrderflow) {
            try {
              orderflowMap = await getOrderflowSnapshotMap(env);
            } catch (e) {
              console.error("[screener-accum] Failed to load orderflow map:", e);
            }
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

      // GET /orderflow/snapshots?symbols=BBRI,TLKM,...
      if (url.pathname === "/orderflow/snapshots" && req.method === "GET") {
        try {
          const symbolsRaw = String(url.searchParams.get("symbols") || "").trim().toUpperCase();
          if (!symbolsRaw) {
            return json({ ok: false, error: "symbols query param required (comma-separated)" }, 400);
          }

          const symbols = [...new Set(
            symbolsRaw.split(",").map(s => s.trim()).filter(s => /^[A-Z]{2,6}$/.test(s))
          )].slice(0, 120);

          if (!symbols.length) {
            return json({ ok: false, error: "No valid symbols provided" }, 400);
          }

          const snapshots = await getOrderflowSnapshotMap(env, symbols);
          const firstSnapshot = Object.values(snapshots || {})[0] || null;
          return json({
            ok: true,
            requested: symbols.length,
            count: Object.keys(snapshots || {}).length,
            trading_date: firstSnapshot?.trading_date || null,
            generated_at: new Date().toISOString(),
            snapshots: snapshots || {}
          }, 200, {
            "Cache-Control": "public, max-age=15, stale-while-revalidate=45"
          });
        } catch (e) {
          return json({ ok: false, error: "Failed to fetch orderflow snapshots", details: e.message }, 500);
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
          const rows = await getBrokersRowsCached(env);
          return json({ brokers: rows || [] }); // Return array or object? User snippet expects { brokers: map } or array?
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
        const includeOrderflowRaw = String(url.searchParams.get("include_orderflow") || "").toLowerCase();
        const includeOrderflow = includeOrderflowRaw === "true" || includeOrderflowRaw === "1" || includeOrderflowRaw === "yes";

        let cacheMode = url.searchParams.get("cache") || "default";
        if (url.searchParams.get("reload") === "true") cacheMode = "rebuild";

        if (!symbol || !from || !to) return json({ error: "Missing params (symbol, from, to)" }, 400);

        const key = `broker/summary/v7/${symbol}/${from}_${to}.json`;

        // 1. READ CACHE (Only if mode is default)
        if (cacheMode === "default") {
          const cached = await env.SSSAHAM_EMITEN.get(key);
          if (cached) {
            // ── Staleness check: if cache was generated before last market close, invalidate ──
            let cacheIsStale = false;
            try {
              const genAt = cached.customMetadata?.generated_at;
              if (genAt) {
                const genMs = new Date(genAt).getTime();
                const nowMs = Date.now();
                const ageHours = (nowMs - genMs) / 3600000;
                // If to-date covers today or the latest trading day and cache is >3h old,
                // it likely misses today's data. Invalidate.
                const lastTD = getLastTradingDayWIB();
                if (to >= lastTD && ageHours > 3) {
                  console.log(`[cache-summary] Cache STALE for ${symbol}: generated ${Math.round(ageHours)}h ago, lastTD=${lastTD}`);
                  cacheIsStale = true;
                }
              }
            } catch (_) { }

            if (!cacheIsStale) {
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
            } // end !cacheIsStale
            // If stale or missing, fallthrough to re-calculate (MISS/STALE)
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

      // 4b. GET /cache-summary/broker-daily — Per-broker daily net for top 9 brokers
      if (url.pathname === "/cache-summary/broker-daily" && req.method === "GET") {
        const symbol = url.searchParams.get("symbol");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!symbol || !from || !to) return json({ error: "Missing params (symbol, from, to)" }, 400);

        let cacheMode = url.searchParams.get("cache") || "default";
        if (url.searchParams.get("reload") === "true") cacheMode = "rebuild";

        const cacheKey = `broker/daily/v3/${symbol}/${from}_${to}.json`;

        // 1. Check R2 cache
        if (cacheMode === "default") {
          const cached = await env.SSSAHAM_EMITEN.get(cacheKey);
          if (cached) {
            // ── Staleness check: if cache was generated before last market close, invalidate ──
            let cacheIsStale = false;
            try {
              const genAt = cached.customMetadata?.generated_at;
              if (genAt) {
                const ageHours = (Date.now() - new Date(genAt).getTime()) / 3600000;
                const lastTD = getLastTradingDayWIB();
                if (to >= lastTD && ageHours > 3) {
                  console.log(`[broker-daily] Cache STALE for ${symbol}: generated ${Math.round(ageHours)}h ago, lastTD=${lastTD}`);
                  cacheIsStale = true;
                }
              }
            } catch (_) { }

            if (!cacheIsStale) {
            try {
              const data = await cached.json();
              if (data && data.brokers && data.dates) {
                return withCORS(new Response(JSON.stringify(data), {
                  headers: { "Content-Type": "application/json", "X-Cache": "HIT" }
                }));
              }
            } catch (_) { /* stale cache, fallthrough */ }
            } // end !cacheIsStale
          }
        }

        // 2. Calculate per-broker daily data
        let brokersMap = Object.create(null);
        try {
          brokersMap = await getBrokersMapCached(env);
        } catch (e) { console.error("broker-daily: Error fetching brokers:", e); }

        const isRetail = (code) => {
          const b = brokersMap[code];
          if (!b) return false;
          return (b.category || '').toLowerCase().includes('retail');
        };

        const classifyBroker = (code, ipotType) => {
          if (isRetail(code)) return 'retail';
          if (ipotType === 'Asing') return 'foreign';
          return 'local';
        };

        const start = new Date(from);
        const end = new Date(to);
        const dateList = [];
        const candidateDateList = [];
        // perBroker[code] = { dailyNets: [net_day1, net_day2, ...], type: 'foreign'|'local'|'retail', ipotType: 'Asing' }
        const perBroker = {};

        // Build weekday candidates first.
        // Holiday filtering is applied after fetch with data-aware override:
        // keep holiday dates only when broker rows are actually present.
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          if (isWeekendUTC(dateStr)) continue;
          candidateDateList.push(dateStr);
        }

        // ── Parallel R2 reads for all weekday candidates ──
        const bdR2Results = await Promise.all(
          candidateDateList.map(async (dateStr) => {
            // Try legacy path first (without ipot/ prefix)
            const keyLegacy = `${symbol}/${dateStr}.json`;
            const keyIpot = `${symbol}/ipot/${dateStr}.json`;
            try {
              let object = await env.RAW_BROKSUM.get(keyLegacy);
              // If not found, try ipot path (broksum-scrapper stores here)
              if (!object) {
                object = await env.RAW_BROKSUM.get(keyIpot);
              }
              if (!object) return { dateStr, data: null };
              const fullOuter = await object.json();
              return { dateStr, data: fullOuter?.data || null };
            } catch (e) {
              return { dateStr, data: null };
            }
          })
        );

        // Process each day with data-aware holiday override
        // (holiday dates are kept only when valid broker rows exist).
        for (const r of bdR2Results) {
          const bs = r?.data?.broker_summary;
          const hasRows = hasBrokerRows(bs);
          if (isHolidayUTC(r.dateStr) && !hasRows) {
            continue;
          }
          dateList.push(r.dateStr);
          const dayIdx = dateList.length - 1;

          if (!r.data || !hasRows) {
            // Keep axis continuity: if a kept day has no data, pad existing brokers with 0.
            for (const info of Object.values(perBroker)) {
              while (info.dailyNets.length <= dayIdx) {
                info.dailyNets.push(0);
              }
            }
            continue;
          }

            // Process each broker on this day
            const dayBrokerNet = {}; // code -> net

            const processList = (list, side) => {
              if (!Array.isArray(list)) return;
              list.forEach(b => {
                if (!b) return;
                const code = b.netbs_broker_code;
                if (!code) return;
                const val = parseFloat(side === 'buy' ? b.bval : b.sval) || 0;
                if (!dayBrokerNet[code]) dayBrokerNet[code] = { buy: 0, sell: 0, ipotType: b.type };
                if (side === 'buy') dayBrokerNet[code].buy += val;
                else dayBrokerNet[code].sell += val;
              });
            };

            processList(bs.brokers_buy, 'buy');
            processList(bs.brokers_sell, 'sell');

            // Merge into perBroker
            for (const [code, data] of Object.entries(dayBrokerNet)) {
              if (!perBroker[code]) {
                const cat = classifyBroker(code, data.ipotType);
                perBroker[code] = { dailyNets: new Array(dayIdx).fill(0), type: cat, ipotType: data.ipotType };
              }
              // Pad any missing days (if broker appeared late)
              while (perBroker[code].dailyNets.length < dayIdx) {
                perBroker[code].dailyNets.push(0);
              }
              perBroker[code].dailyNets.push(data.buy - data.sell);
            }

            // Pad brokers that didn't appear today
            for (const [code, info] of Object.entries(perBroker)) {
              while (info.dailyNets.length <= dayIdx) {
                info.dailyNets.push(0);
              }
            }
        }

        // 3. Select top brokers by abs(total net) — ranked globally, not per-category
        const allBrokersSorted = [];
        for (const [code, info] of Object.entries(perBroker)) {
          const totalNet = info.dailyNets.reduce((s, v) => s + v, 0);
          allBrokersSorted.push({ code, totalAbsNet: Math.abs(totalNet), totalNet, type: info.type });
        }
        allBrokersSorted.sort((a, b) => b.totalAbsNet - a.totalAbsNet);

        // Return top 12 (client controls visibility via Top 3/5/9 toggle)
        const topCount = Math.min(12, allBrokersSorted.length);
        const selectedBrokers = [];
        for (let i = 0; i < topCount; i++) {
          const b = allBrokersSorted[i];
          const bInfo = brokersMap[b.code];
          selectedBrokers.push({
            code: b.code,
            name: bInfo?.name || b.code,
            type: b.type
          });
        }

        // 4. Build series for selected brokers
        const series = {};
        selectedBrokers.forEach(b => {
          series[b.code] = perBroker[b.code]?.dailyNets || new Array(dateList.length).fill(0);
          // Ensure correct length
          while (series[b.code].length < dateList.length) series[b.code].push(0);
        });

        const responseData = {
          symbol,
          from,
          to,
          brokers: selectedBrokers,
          dates: dateList,
          series
        };

        // 5. Write to R2 cache
        if (cacheMode !== "off") {
          const ttl = cacheMode === "rebuild" ? 604800 : 172800;
          ctx.waitUntil(env.SSSAHAM_EMITEN.put(cacheKey, JSON.stringify(responseData), {
            httpMetadata: { contentType: "application/json", cacheControl: `public, max-age=${ttl}` },
            customMetadata: { generated_at: new Date().toISOString(), ttl: ttl.toString() }
          }));
        }

        return withCORS(new Response(JSON.stringify(responseData), {
          headers: { "Content-Type": "application/json", "X-Cache": "MISS" }
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

      // 6.6 DEBUG: SSSAHAM_EMITEN File Inspection (admin only)
      if (url.pathname === "/debug/emiten-file") {
        const auth = requireIdxAdmin(req, env);
        if (!auth.ok) return auth.response;

        const key = url.searchParams.get("key");
        if (!key) return json({ error: "Missing key" }, 400);

        try {
          const obj = await env.SSSAHAM_EMITEN.get(key);
          if (!obj) return json({ error: "Object not found", key }, 404);

          const headers = new Headers({ "Content-Type": "application/x-ndjson; charset=utf-8" });
          return new Response(obj.body, { headers });
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
      // Uses backend Browser Rendering screenshots (5 targets) with client fallback
      if (url.pathname === "/ai/analyze-broksum" && req.method === "POST") {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ ok: false, error: "Missing ANTHROPIC_API_KEY in environment" }, 500);
        }

        const contentType = req.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Expected application/json body" }, 400);
        }

        const body = await req.json();
        const { symbol, image_keys } = body; // [{key,label}, ...] optional client fallback
        const forceRefresh = body.force === true;

        const normalizedSymbol = (symbol || "").toString().trim().toUpperCase();
        if (!normalizedSymbol) {
          return json({ ok: false, error: "Missing required field: symbol" }, 400);
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

        // --- Step 1: Obtain screenshots — check R2 cache first, then Browser Rendering
        let aggregatedKeys = [];
        let screenshotSource = "none";

        // Expected screenshot labels (must match ai-screenshot-service targets)
        const SCREENSHOT_LABELS = [
          "smartmoney-chart", "broker-flow-chart", "zscore-horizon",
          "broker-table", "intraday-footprint"
        ];
        const SCREENSHOT_PREFIX = `ai-screenshots/${normalizedSymbol}/${today}_`;
        const MIN_SCREENSHOT_SIZE = 5000; // bytes — skip tiny/placeholder images
        const SCREENSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

        // 1a. Check if screenshots already exist in R2 (fast — avoids 60-90s Browser Rendering)
        // Note: forceRefresh only applies to AI analysis cache, NOT screenshot assets
        {
          try {
            const headChecks = SCREENSHOT_LABELS.map(async (label) => {
              const key = `${SCREENSHOT_PREFIX}${label}.png`;
              const head = await env.SSSAHAM_EMITEN.head(key);
              if (!head || head.size < MIN_SCREENSHOT_SIZE) return null;
              // Check freshness via uploaded timestamp
              const uploadedAt = head.uploaded ? head.uploaded.getTime() : 0;
              const age = Date.now() - uploadedAt;
              if (age > SCREENSHOT_MAX_AGE_MS) return null; // stale
              return { key, label, normalizedLabel: label.toLowerCase(), size: head.size };
            });
            const existing = (await Promise.all(headChecks)).filter(Boolean);
            if (existing.length >= 3) {
              aggregatedKeys = existing;
              screenshotSource = "r2-cached";
              console.log(`[AI] R2 cache HIT: ${existing.length}/${SCREENSHOT_LABELS.length} screenshots for ${normalizedSymbol} (${existing.map(e => e.label).join(', ')})`);
            } else {
              console.log(`[AI] R2 cache: only ${existing.length} valid screenshots — need fresh capture`);
            }
          } catch (r2Err) {
            console.warn(`[AI] R2 screenshot cache check failed: ${r2Err.message}`);
          }
        }

        // 1b. Capture via backend Browser Rendering only if R2 cache miss
        if (aggregatedKeys.length === 0 && env.AI_SCREENSHOT_SERVICE) {
          try {
            console.log(`[AI] Triggering backend screenshot batch for ${normalizedSymbol}...`);
            const captureResp = await env.AI_SCREENSHOT_SERVICE.fetch(
              new Request("https://ai-screenshot-service/capture/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ symbol: normalizedSymbol, date: today })
              })
            );
            const captureResult = await captureResp.json();
            if (captureResult.ok && Array.isArray(captureResult.results)) {
              const successItems = captureResult.results.filter(r => r.ok);
              if (successItems.length > 0) {
                aggregatedKeys = successItems.map(r => ({
                  key: r.key,
                  label: r.label,
                  normalizedLabel: r.label.toLowerCase()
                }));
                screenshotSource = "browser-rendering";
                console.log(`[AI] Backend screenshots: ${successItems.length}/${captureResult.results.length} succeeded`);
              }
            }
          } catch (captureErr) {
            console.warn(`[AI] Backend screenshot service failed: ${captureErr.message}`);
          }
        }

        // 1c. Fallback: use client-provided image_keys
        if (aggregatedKeys.length === 0 && Array.isArray(image_keys) && image_keys.length > 0) {
          console.log(`[AI] Falling back to client-provided screenshots`);
          const aggregatedMap = new Map();
          image_keys.forEach((ik) => {
            if (!ik || typeof ik.key !== "string") return;
            const key = ik.key;
            const labelRaw = typeof ik.label === "string" ? ik.label.trim() : "screenshot";
            const normalizedLabel = (labelRaw || "screenshot").toLowerCase();
            aggregatedMap.set(key, { key, label: labelRaw || "screenshot", normalizedLabel });
          });
          aggregatedKeys = Array.from(aggregatedMap.values());
          screenshotSource = "client";
        }

        if (aggregatedKeys.length === 0) {
          return json({ ok: false, error: "No screenshots available — backend capture failed and no client images provided" }, 400);
        }

        // --- validate screenshot existence (HEAD) — skip for r2-cached (already validated)
        if (screenshotSource !== "r2-cached") {
          const validatedKeys = [];
          const headPromises = aggregatedKeys.map(async (ik) => {
            try {
              const head = await env.SSSAHAM_EMITEN.head(ik.key);
              if (head) return ik;
              console.warn(`[AI] Screenshot not found in R2: ${ik.key}`);
              return null;
            } catch (headErr) {
              console.warn(`[AI] HEAD failed for ${ik.key}:`, headErr.message);
              return null;
            }
          });
          aggregatedKeys = (await Promise.all(headPromises)).filter(Boolean);
        }

        if (aggregatedKeys.length === 0) {
          return json({ ok: false, error: "No valid screenshots found in storage" }, 400);
        }

        console.log(`[AI] Using ${aggregatedKeys.length} screenshots (source: ${screenshotSource}): ${aggregatedKeys.map(k => k.label).join(', ')}`);

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

          // Read images from R2 directly and send as base64 inline
          // URL-based delivery is unreliable — Claude servers may timeout fetching our URLs
          // R2 reads from within the Worker are fast (~5ms each) and in same data center
          const imageReadPromises = aggregatedKeys.map(async (ik) => {
            try {
              const obj = await env.SSSAHAM_EMITEN.get(ik.key);
              if (!obj) {
                console.warn(`[Claude] Missing in R2: ${ik.key}`);
                return null;
              }
              const buf = await obj.arrayBuffer();
              if (buf.byteLength < 5000) {
                console.warn(`[Claude] Image ${ik.label} too small (${buf.byteLength} bytes)`);
                return null;
              }
              // Convert to base64 (Cloudflare Workers support btoa on binary strings)
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              const b64 = btoa(binary);
              console.log(`[Claude] Image ${ik.label}: ${(buf.byteLength / 1024).toFixed(0)} KB via base64`);
              return {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: b64 }
              };
            } catch (e) {
              console.warn(`[Claude] Failed to read ${ik.key}: ${e.message}`);
              return null;
            }
          });
          const imageBlocks = (await Promise.all(imageReadPromises)).filter(Boolean);

          // If no valid images, fall back to text-only analysis
          const hasImages = imageBlocks.length > 0;
          console.log(`[Claude] ${hasImages ? imageBlocks.length + ' images via base64' : 'no valid images — text-only mode'}`);

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
            model: "claude-opus-4-6",
            max_tokens: 16000,
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
                model: "claude-opus-4-6",
                max_tokens: 16000,
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

        // --- run provider with fallback chain: Claude Opus → OpenAI → Grok
        let provider = "claude";
        let modelUsed = "claude-opus-4-6";
        let analysisJson = null;
        let rawContent = "";
        let usage = {};

        try {
          console.log(`[AI] Calling Claude Opus for ${normalizedSymbol} with ${aggregatedKeys.length} images`);
          const out = await callClaudeWithImages();
          analysisJson = out.analysisJson;
          rawContent = out.rawContent;
          usage = out.usage || {};
        } catch (claudeErr) {
          console.warn(`[AI] Claude failed: ${claudeErr.message}. Falling back to OpenAI.`);
          provider = "openai";
          modelUsed = "gpt-4.1";

          try {
            const out = await callOpenAIWithJsonRetry();
            analysisJson = out.analysisJson;
            rawContent = out.rawContent;
            usage = out.usage || {};
          } catch (openaiErr) {
            console.warn(`[AI] OpenAI fallback failed: ${openaiErr.message}. Falling back to Grok.`);
            provider = "grok";
            modelUsed = "grok-4";

            try {
              const out = await callGrokTextOnly();
              analysisJson = out.analysisJson;
              rawContent = out.rawContent;
              usage = out.usage || {};
            } catch (grokErr) {
              console.error("[AI] Grok fallback failed:", grokErr.message);
              return json(
                {
                  ok: false,
                  error: "All AI providers failed",
                  claude: claudeErr.message,
                  openai: openaiErr.message,
                  grok: grokErr.message
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

        try {
          await ensureDashboardTables(env);
          const feedEvent = buildFeedEventFromAnalysis(
            normalizedSymbol,
            analysisJson,
            provider,
            modelUsed,
            fromDate,
            toDate,
            cacheKey
          );
          await env.SSSAHAM_DB.prepare(
            `INSERT INTO feed_events (event_type, symbol, title, body, meta_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
            .bind(
              feedEvent.event_type,
              feedEvent.symbol,
              feedEvent.title,
              feedEvent.body,
              feedEvent.meta_json,
              new Date().toISOString()
            )
            .run();
        } catch (feedErr) {
          console.error("[AI] Failed to append feed event:", feedErr);
        }

        return json(result);
      }

      // ── GET /ai/claude-score/verify — List recent R2 cache artifacts for verification ──
      if (url.pathname === "/ai/claude-score/verify" && req.method === "GET") {
        try {
          const now = new Date();
          const wibMs = now.getTime() + 7 * 3600000;
          const wibDate = new Date(wibMs);
          const dateStr = url.searchParams.get("date") || wibDate.toISOString().split("T")[0];
          const filterHash = url.searchParams.get("hash") || null;

          const prefix = `ai-screener-cache/${dateStr}/`;
          const listed = await env.SSSAHAM_EMITEN.list({ prefix, limit: 50 });
          const artifacts = [];

          for (const obj of listed.objects) {
            const meta = obj.customMetadata || {};
            artifacts.push({
              key: obj.key,
              size: obj.size,
              uploaded: obj.uploaded,
              generated_at: meta.generated_at || null,
              universe_size: meta.universe_size || null,
              filter_hash: meta.filter_hash || null,
              model: meta.model || null,
              ttl_minutes: meta.ttl_minutes || null
            });
          }

          // If hash is specified, also fetch the latest_{hash}.json content for comparison
          let latestContent = null;
          if (filterHash) {
            const latestKey = `ai-screener-cache/${dateStr}/latest_${filterHash}.json`;
            const latestObj = await env.SSSAHAM_EMITEN.get(latestKey);
            if (latestObj) {
              const body = await latestObj.json();
              latestContent = {
                key: latestKey,
                ok: body.ok,
                universe_size: body.universe_size,
                symbols: body.symbols || Object.keys(body.scores || {}),
                symbol_count: (body.symbols || Object.keys(body.scores || {})).length,
                score_count: Object.keys(body.scores || {}).length,
                top5: body.top5,
                summary: body.summary,
                filter_state: body.filter_state,
                filter_hash: body.filter_hash,
                generated_at: body.generated_at,
                model: body.model,
                elapsed_ms: body.elapsed_ms
              };
            }
          }

          return json({
            ok: true,
            date: dateStr,
            filter_hash_query: filterHash,
            artifact_count: artifacts.length,
            artifacts,
            latest: latestContent
          });
        } catch (err) {
          return json({ ok: false, error: err.message }, 500);
        }
      }

      // ── POST /ai/claude-score — Batch AI scoring for screener candidates ──
      if (url.pathname === "/ai/claude-score" && req.method === "POST") {
        try {
          const body = await req.json();
          const candidates = body?.candidates;
          const filterState = body?.filter_state || {};
          const symbolsList = body?.symbols || [];
          const sortKey = body?.sort_key || '';
          const sortDir = body?.sort_dir || '';

          // ── Validate payload ──
          if (!Array.isArray(candidates) || candidates.length < 10 || candidates.length > 1000) {
            return json({ ok: false, error: "candidates array required (10-1000 items)" }, 400);
          }
          for (const c of candidates) {
            if (!c.symbol || typeof c.symbol !== "string") {
              return json({ ok: false, error: "Each candidate must have a string 'symbol'" }, 400);
            }
          }

          // ── Build filter hash for cache key ──
          const filterParts = [];
          for (const [k, v] of Object.entries(filterState).sort()) {
            filterParts.push(`${k}=${v}`);
          }
          filterParts.push(`n=${candidates.length}`);
          let filterHash = 'all';
          if (filterParts.length > 1) {
            let h = 0;
            const s = filterParts.join('&');
            for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
            filterHash = (h >>> 0).toString(36);
          }

          // ── Date helpers (WIB = UTC+7) ──
          const now = new Date();
          const wibMs = now.getTime() + 7 * 3600000;
          const wibDate = new Date(wibMs);
          const dateStr = wibDate.toISOString().split("T")[0]; // YYYY-MM-DD WIB
          const timeStr = wibDate.toISOString().split("T")[1].replace(/[:\.]/g, "").slice(0, 6); // HHmmss

          // ── Check R2 cache (TTL 30 min) — filter-aware ──
          const R2_CACHE_TTL_MIN = 30;
          const cacheKey = `ai-screener-cache/${dateStr}/latest_${filterHash}.json`;
          try {
            const cached = await env.SSSAHAM_EMITEN.get(cacheKey);
            if (cached) {
              const meta = cached.customMetadata || {};
              const generatedAt = meta.generated_at || "";
              if (generatedAt) {
                const age = (now.getTime() - new Date(generatedAt).getTime()) / 60000;
                if (age < R2_CACHE_TTL_MIN) {
                  console.log(`[Claude-Score] R2 cache hit, age=${age.toFixed(1)}min, ttl=${R2_CACHE_TTL_MIN}min`);
                  const cachedBody = await cached.json();
                  cachedBody.source = "r2_cache";
                  cachedBody.cache_age_min = Math.round(age * 10) / 10;
                  return json(cachedBody);
                }
              }
            }
          } catch (cacheErr) {
            console.warn("[Claude-Score] R2 cache check error:", cacheErr.message);
          }

          // ── ANTHROPIC_API_KEY check ──
          if (!env.ANTHROPIC_API_KEY) {
            return json({ ok: false, error: "Missing ANTHROPIC_API_KEY" }, 500);
          }

          // ── Fetch prompt from prompt-service ──
          let systemPrompt, userTemplate, claudeModel, claudeMaxTokens;
          try {
            const promptResp = await env.PROMPT_SERVICE.fetch(
              new Request("https://prompt-service/prompts/claude-screener-score")
            );
            if (promptResp.ok) {
              const promptData = await promptResp.json();
              systemPrompt = promptData.prompt?.system;
              userTemplate = promptData.prompt?.user_template;
              claudeModel = promptData.model;
              claudeMaxTokens = promptData.max_tokens;
            }
          } catch (e) {
            console.warn("[Claude-Score] prompt-service fetch failed, using fallback:", e.message);
          }

          // Fallback prompt if prompt-service unavailable
          if (!systemPrompt) {
            systemPrompt = `Anda adalah expert analis pasar saham Indonesia. Score setiap emiten 0-100 berdasarkan potensi naik +5% dalam 5 hari ke depan. Pertimbangkan smart money flow, effort z-score, orderflow intraday, state, dan trend quality. Return ONLY valid JSON: { "scores": { "SYMBOL": number, ... }, "top5": [...], "summary": { "high_confidence": n, "medium_confidence": n, "low_confidence": n } }`;
          }
          if (!userTemplate) {
            userTemplate = `Score semua {universe_size} emiten berikut berdasarkan potensi naik +5% dalam 5 hari ke depan.\n\nDATA:\n{candidates_json}`;
          }

          // ── Build compact candidate JSON ──
          const compactCandidates = candidates.map(c => ({
            s: c.symbol,
            g: c.growth_pct ?? null,
            fq: c.freq ?? null,
            sm: c.sm || [0,0,0,0],
            fn: c.fn || [0,0,0,0],
            ln: c.ln || [0,0,0,0],
            fl: c.flow || [0,0,0,0],
            ef: c.effort || [0,0,0,0],
            vw: c.vwap || [null,null,null,null],
            ng: c.ngr || [null,null,null,null],
            rv: c.rvol || [null,null,null,null],
            cm: c.cvd_multi || [null,null,null,null],
            of: c.orderflow || {},
            q: c.quadrant || null,
            st: c.state || "NEUTRAL",
            tr: c.trend || {}
          }));

          const userMessage = userTemplate
            .replace("{universe_size}", String(candidates.length))
            .replace("{candidates_json}", JSON.stringify(compactCandidates));

          // ── Call Claude API ──
          const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
          const claudePayload = {
            model: claudeModel || "claude-opus-4-6",
            max_tokens: claudeMaxTokens || 16000,
            system: systemPrompt,
            messages: [{ role: "user", content: userMessage }]
          };

          console.log(`[Claude-Score] Calling Claude API with ${candidates.length} candidates...`);
          const startTime = Date.now();

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
            console.error(`[Claude-Score] API error: ${resp.status} - ${errText}`);
            if (resp.status === 429) {
              return json({ ok: false, error: "Rate limited, coba lagi nanti", status: 429 }, 429);
            }
            return json({ ok: false, error: `Claude API error: ${resp.status}`, status: resp.status }, 502);
          }

          const data = await resp.json();
          const rawContent = data.content?.[0]?.text || "";
          const usage = {
            input_tokens: data.usage?.input_tokens || 0,
            output_tokens: data.usage?.output_tokens || 0
          };

          // ── Parse Claude response JSON ──
          let parsed;
          try {
            // Strip markdown code fences if present
            let cleanJson = rawContent.trim();
            if (cleanJson.startsWith("```")) {
              cleanJson = cleanJson.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
            }
            parsed = JSON.parse(cleanJson);
          } catch (parseErr) {
            console.warn(`[Claude-Score] First parse failed: ${parseErr.message}. Retrying with correction...`);

            // Retry with correction prompt
            try {
              const retryResp = await fetch(CLAUDE_URL, {
                method: "POST",
                headers: {
                  "x-api-key": env.ANTHROPIC_API_KEY,
                  "anthropic-version": "2023-06-01",
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  model: claudeModel || "claude-opus-4-6",
                  max_tokens: claudeMaxTokens || 16000,
                  system: systemPrompt,
                  messages: [
                    { role: "user", content: userMessage },
                    { role: "assistant", content: rawContent },
                    { role: "user", content: `Output sebelumnya bukan JSON valid. Error: ${parseErr.message}. Kembalikan HANYA JSON object valid, mulai dari '{' tanpa markdown code fences.` }
                  ]
                })
              });
              if (retryResp.ok) {
                const retryData = await retryResp.json();
                let retryText = (retryData.content?.[0]?.text || "").trim();
                if (retryText.startsWith("```")) {
                  retryText = retryText.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
                }
                parsed = JSON.parse(retryText);
                usage.input_tokens += retryData.usage?.input_tokens || 0;
                usage.output_tokens += retryData.usage?.output_tokens || 0;
              } else {
                throw new Error("Retry request failed");
              }
            } catch (retryErr) {
              console.error("[Claude-Score] Retry also failed:", retryErr.message);
              return json({ ok: false, error: "AI returned invalid JSON after retry" }, 500);
            }
          }

          // ── Validate parsed response ──
          if (!parsed?.scores || typeof parsed.scores !== "object") {
            return json({ ok: false, error: "AI response missing 'scores' object" }, 500);
          }

          const elapsedMs = Date.now() - startTime;
          const generatedAt = new Date().toISOString();

          // Count confidence buckets
          const scoreValues = Object.values(parsed.scores);
          const summary = parsed.summary || {
            high_confidence: scoreValues.filter(s => s >= 70).length,
            medium_confidence: scoreValues.filter(s => s >= 50 && s < 70).length,
            low_confidence: scoreValues.filter(s => s < 50).length
          };

          // Build ordered symbol list (preserving input order for verification)
          const scoredSymbols = symbolsList.length === candidates.length
            ? symbolsList.map(s => String(s).toUpperCase())
            : candidates.map(c => String(c.symbol).toUpperCase());

          const result = {
            ok: true,
            scores: parsed.scores,
            symbols: scoredSymbols,
            top5: parsed.top5 || Object.entries(parsed.scores).sort((a,b) => b[1]-a[1]).slice(0,5).map(e => e[0]),
            summary,
            filter_state: filterState,
            filter_hash: filterHash,
            sort_key: sortKey,
            sort_dir: sortDir,
            generated_at: generatedAt,
            source: "claude_api",
            model: claudeModel || "claude-opus-4-6",
            usage,
            elapsed_ms: elapsedMs,
            universe_size: candidates.length
          };

          // ── Save to R2 (immutable artifact + latest pointer) ──
          const artifactKey = `ai-screener-cache/${dateStr}/${timeStr}_${filterHash}_${candidates.length}.json`;
          const r2Meta = {
            httpMetadata: { contentType: "application/json" },
            customMetadata: {
              generated_at: generatedAt,
              universe_size: String(candidates.length),
              model: claudeModel || "claude-opus-4-6",
              filter_hash: filterHash,
              ttl_minutes: String(R2_CACHE_TTL_MIN)
            }
          };
          const resultJson = JSON.stringify(result);

          try {
            await Promise.all([
              env.SSSAHAM_EMITEN.put(artifactKey, resultJson, r2Meta),
              env.SSSAHAM_EMITEN.put(cacheKey, resultJson, r2Meta)
            ]);
            console.log(`[Claude-Score] Saved: ${artifactKey} + latest_${filterHash}.json (${elapsedMs}ms, ${candidates.length} emiten)`);
          } catch (r2Err) {
            console.error("[Claude-Score] R2 save failed:", r2Err.message);
            // Still return result even if R2 fails
          }

          return json(result);

        } catch (err) {
          console.error("[Claude-Score] Unexpected error:", err.stack || err.message);
          return json({ ok: false, error: "Internal error", details: err.message }, 500);
        }
      }

      // 7.0 POST /admin/backfill-feed — Re-derive title & meta_json from R2 cache for all feed_events
      if (url.pathname === "/admin/backfill-feed" && req.method === "POST") {
        await ensureDashboardTables(env);

        const dryRun = url.searchParams.get("dry") === "1";
        const { results } = await env.SSSAHAM_DB.prepare(
          `SELECT id, event_type, symbol, title, body, meta_json, created_at
           FROM feed_events ORDER BY created_at DESC LIMIT 500`
        ).all();

        const rows = results || [];
        const report = { total: rows.length, updated: 0, skipped: 0, errors: 0, details: [] };

        for (const row of rows) {
          const meta = parseFeedMeta(row.meta_json);
          const cacheKey = meta?.cache_key;
          if (!cacheKey) {
            report.skipped++;
            report.details.push({ id: row.id, symbol: row.symbol, status: "skip_no_cache_key" });
            continue;
          }

          let payload = null;
          try {
            const obj = await env.SSSAHAM_EMITEN.get(cacheKey);
            if (!obj) { report.skipped++; report.details.push({ id: row.id, symbol: row.symbol, status: "skip_r2_miss" }); continue; }
            payload = await obj.json();
          } catch (_) {
            report.errors++;
            report.details.push({ id: row.id, symbol: row.symbol, status: "error_r2_parse" });
            continue;
          }

          const analysis = payload?.analysis || {};
          const fromDate = payload?.date_range?.from || meta?.from || "unknown";
          const toDate = payload?.date_range?.to || meta?.to || "unknown";
          const provider = payload?.provider || meta?.provider || "unknown";
          const model = payload?.model || meta?.model || "unknown";

          const rebuilt = buildFeedEventFromAnalysis(
            row.symbol, analysis, provider, model, fromDate, toDate, cacheKey
          );

          // Compare: skip if title, body, and meta_json all identical
          if (rebuilt.title === row.title && rebuilt.body === row.body && rebuilt.meta_json === row.meta_json) {
            report.skipped++;
            report.details.push({ id: row.id, symbol: row.symbol, status: "skip_identical" });
            continue;
          }

          if (!dryRun) {
            try {
              await env.SSSAHAM_DB.prepare(
                `UPDATE feed_events SET title = ?, body = ?, meta_json = ? WHERE id = ?`
              ).bind(rebuilt.title, rebuilt.body, rebuilt.meta_json, row.id).run();
            } catch (upErr) {
              report.errors++;
              report.details.push({ id: row.id, symbol: row.symbol, status: "error_update", error: upErr.message });
              continue;
            }
          }

          report.updated++;
          report.details.push({
            id: row.id, symbol: row.symbol, status: dryRun ? "would_update" : "updated",
            old_title: row.title, new_title: rebuilt.title,
            old_reco: meta?.recommendation || "-", new_reco: JSON.parse(rebuilt.meta_json)?.recommendation || "-"
          });
        }

        return json({ ok: true, dry_run: dryRun, report });
      }

      // 7.1 GET /dashboard/feed/detail?slug=YYYY-MM-DD-SYMBOL-title
      if (url.pathname === "/dashboard/feed/detail" && req.method === "GET") {
        await ensureDashboardTables(env);
        const slug = String(url.searchParams.get("slug") || url.searchParams.get("feed") || "").trim();
        if (!slug) {
          return json({ ok: false, error: "Missing slug" }, 400);
        }

        let resolvedItem = null;
        let resolvedPayload = null;

        const { results } = await env.SSSAHAM_DB.prepare(
          `SELECT id, event_type, symbol, title, body, meta_json, created_at
           FROM feed_events
           ORDER BY created_at DESC, id DESC
           LIMIT 500`
        ).all();

        for (const row of (results || [])) {
          const candidate = {
            id: row.id,
            event_type: row.event_type,
            symbol: row.symbol,
            title: row.title,
            body: row.body,
            meta: parseFeedMeta(row.meta_json),
            created_at: row.created_at
          };
          candidate.slug = buildFeedDetailSlug(candidate);
          if (candidate.slug !== slug) continue;

          resolvedItem = candidate;
          const cacheKey = candidate?.meta?.cache_key;
          if (cacheKey) {
            const obj = await env.SSSAHAM_EMITEN.get(cacheKey);
            if (obj) {
              try {
                resolvedPayload = await obj.json();
              } catch (_) {
                resolvedPayload = null;
              }
            }
          }
          break;
        }

        if (!resolvedItem) {
          const slugMatch = slug.match(/^\d{4}-\d{2}-\d{2}-([A-Z0-9]+)-/i);
          const symbolGuess = String(slugMatch?.[1] || "").toUpperCase();
          const prefix = symbolGuess ? `ai-cache/${symbolGuess}/` : "ai-cache/";
          const listed = await env.SSSAHAM_EMITEN.list({ prefix, limit: 120 });
          const objects = Array.isArray(listed?.objects) ? listed.objects : [];
          objects.sort((a, b) => {
            const ta = Date.parse(String(a?.uploaded || 0)) || 0;
            const tb = Date.parse(String(b?.uploaded || 0)) || 0;
            return tb - ta;
          });

          for (const obj of objects) {
            if (!obj?.key) continue;
            const cacheObj = await env.SSSAHAM_EMITEN.get(obj.key);
            if (!cacheObj) continue;
            let payload = null;
            try {
              payload = await cacheObj.json();
            } catch (_) {
              continue;
            }

            const symbolFromKey = String(obj.key).split("/")[1] || "";
            const symbol = String(payload?.symbol || symbolFromKey || "").toUpperCase();
            if (!symbol) continue;

            const analysis = payload?.analysis || {};
            const fromDate = payload?.date_range?.from || "unknown";
            const toDate = payload?.date_range?.to || "unknown";
            const event = buildFeedEventFromAnalysis(
              symbol,
              analysis,
              payload?.provider || "cache",
              payload?.model || "unknown",
              fromDate,
              toDate,
              obj.key
            );

            const candidate = {
              id: `cache-${obj.key}`,
              event_type: event.event_type,
              symbol: event.symbol,
              title: event.title,
              body: event.body,
              meta: parseFeedMeta(event.meta_json),
              created_at: payload?.cached_at || payload?.analyzed_at || new Date(obj.uploaded || Date.now()).toISOString()
            };
            candidate.slug = buildFeedDetailSlug(candidate);
            if (candidate.slug !== slug) continue;

            resolvedItem = candidate;
            resolvedPayload = payload;
            break;
          }
        }

        if (!resolvedItem) {
          return json({ ok: false, error: "Feed detail not found", slug }, 404);
        }

        return json({
          ok: true,
          item: resolvedItem,
          detail: resolvedPayload
            ? {
                provider: resolvedPayload?.provider || resolvedItem?.meta?.provider || null,
                model: resolvedPayload?.model || resolvedItem?.meta?.model || null,
                analyzed_at: resolvedPayload?.analyzed_at || resolvedItem.created_at,
                date_range: resolvedPayload?.date_range || {
                  from: resolvedItem?.meta?.from || null,
                  to: resolvedItem?.meta?.to || null
                },
                analysis: resolvedPayload?.analysis || null,
                analysis_raw: resolvedPayload?.analysis_raw || null,
                screenshots: Array.isArray(resolvedPayload?.screenshots) ? resolvedPayload.screenshots : []
              }
            : null
        });
      }

      // 7.2 GET /dashboard/feed
      if (url.pathname === "/dashboard/feed" && req.method === "GET") {
        await ensureDashboardTables(env);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 30), 1), 200);
        const symbolFilter = String(url.searchParams.get("symbol") || "").trim().toUpperCase();

        let results;
        if (symbolFilter) {
          ({ results } = await env.SSSAHAM_DB.prepare(
            `SELECT id, event_type, symbol, title, body, meta_json, created_at
             FROM feed_events
             WHERE symbol = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          ).bind(symbolFilter, limit).all());
        } else {
          ({ results } = await env.SSSAHAM_DB.prepare(
            `SELECT id, event_type, symbol, title, body, meta_json, created_at
             FROM feed_events
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          ).bind(limit).all());
        }

        const dbItems = (results || []).map((r) => {
          const meta = parseFeedMeta(r.meta_json);
          // Extract recommendation: from meta first, then parse from title for legacy records
          let recommendation = meta?.recommendation || "";
          if (!recommendation && r.title) {
            const m = String(r.title).match(/^[A-Z0-9]+\s+(STRONG_BUY|STRONG_SELL|BUY|SELL|HOLD|AI Update)[:\s]/i)
                   || String(r.title).match(/[•|]\s*(STRONG_BUY|STRONG_SELL|BUY|SELL|HOLD|AI Update)$/i);
            if (m) recommendation = m[1].toUpperCase();
          }
          const item = {
            id: r.id,
            event_type: r.event_type,
            symbol: r.symbol,
            recommendation: recommendation || "AI Update",
            title: r.title,
            body: r.body,
            meta,
            created_at: r.created_at
          };
          item.slug = buildFeedDetailSlug(item);
          return item;
        });

        const existingCacheKeys = new Set(
          dbItems
            .map((it) => it?.meta?.cache_key)
            .filter((v) => typeof v === "string" && v.length > 0)
        );

        const cacheItems = [];
        try {
          const cachePrefix = symbolFilter ? `ai-cache/${symbolFilter}/` : "ai-cache/";
          const listed = await env.SSSAHAM_EMITEN.list({ prefix: cachePrefix, limit: 80 });
          const objects = Array.isArray(listed?.objects) ? listed.objects : [];
          objects.sort((a, b) => {
            const ta = Date.parse(String(a?.uploaded || 0)) || 0;
            const tb = Date.parse(String(b?.uploaded || 0)) || 0;
            return tb - ta;
          });

          for (const obj of objects) {
            if (!obj?.key || existingCacheKeys.has(obj.key)) continue;
            const cacheObj = await env.SSSAHAM_EMITEN.get(obj.key);
            if (!cacheObj) continue;
            let payload = null;
            try {
              payload = await cacheObj.json();
            } catch (_) {
              continue;
            }

            const symbolFromKey = String(obj.key).split("/")[1] || "";
            const symbol = String(payload?.symbol || symbolFromKey || "").toUpperCase();
            if (!symbol) continue;

            const analysis = payload?.analysis || {};
            const fromDate = payload?.date_range?.from || "unknown";
            const toDate = payload?.date_range?.to || "unknown";
            const event = buildFeedEventFromAnalysis(
              symbol,
              analysis,
              payload?.provider || "cache",
              payload?.model || "unknown",
              fromDate,
              toDate,
              obj.key
            );

            const cacheMeta = parseFeedMeta(event.meta_json);
            cacheItems.push({
              id: `cache-${obj.key}`,
              event_type: event.event_type,
              symbol: event.symbol,
              recommendation: cacheMeta?.recommendation || "AI Update",
              title: event.title,
              body: event.body,
              meta: cacheMeta,
              created_at: payload?.cached_at || payload?.analyzed_at || new Date(obj.uploaded || Date.now()).toISOString()
            });

            cacheItems[cacheItems.length - 1].slug = buildFeedDetailSlug(cacheItems[cacheItems.length - 1]);

            if (cacheItems.length >= limit) break;
          }
        } catch (e) {
          console.error("[/dashboard/feed] ai-cache fallback failed:", e);
        }

        const items = [...dbItems, ...cacheItems]
          .sort((a, b) => (Date.parse(String(b?.created_at || 0)) || 0) - (Date.parse(String(a?.created_at || 0)) || 0))
          .slice(0, limit);

        return json({ ok: true, items, total: items.length, from_ai_cache: cacheItems.length });
      }

      // 7.3 POST /dashboard/pubex/refresh?periode=YYYY-MM
      if (url.pathname === "/dashboard/pubex/refresh" && req.method === "POST") {
        await ensureDashboardTables(env);
        if (!env.OPENAI_API_KEY && !env.GROK_API_KEY && !env.ANTHROPIC_API_KEY) {
          return json({ ok: false, error: "Missing OPENAI_API_KEY, GROK_API_KEY, and ANTHROPIC_API_KEY" }, 500);
        }

        const periode = (url.searchParams.get("periode") || new Date().toISOString().slice(0, 7)).trim();
        if (!/^\d{4}-\d{2}$/.test(periode)) {
          return json({ ok: false, error: "Invalid periode, expected YYYY-MM" }, 400);
        }
        const [yStr, mStr] = periode.split("-");
        const year = Number(yStr);
        const monthNum = Number(mStr);
        const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
        const bulanLabel = monthNames[Math.max(0, Math.min(11, monthNum - 1))];

        const userPrompt = `Kamu adalah asisten riset pasar modal Indonesia. Tugasmu adalah mencari jadwal Public Expose emiten yang terdaftar di Bursa Efek Indonesia (BEI) untuk bulan dan tahun ini, lalu mengembalikan hasilnya dalam format JSON.\n\nLangkah-langkah:\n\nCari informasi jadwal Public Expose dari sumber terpercaya seperti idx.co.id, ipotnews.com, indopremier.com, atau kontan.co.id.\nFokus HANYA pada event \"Public Expose\" — bukan RUPS, bukan RUPSLB.\nKembalikan hasil dalam format JSON berikut:\n{\n  \"periode\": \"YYYY-MM\",\n  \"sumber\": [\"nama sumber 1\", \"nama sumber 2\"],\n  \"data\": [\n    {\n      \"kode_emiten\": \"XXXX\",\n      \"nama_perusahaan\": \"Nama PT Tbk\",\n      \"tanggal\": \"DD-MM-YYYY\",\n      \"pukul\": \"HH:MM WIB\",\n      \"lokasi\": \"Nama tempat atau virtual\",\n      \"agenda\": \"Deskripsi singkat agenda public expose\"\n    }\n  ],\n  \"total\": 0,\n  \"catatan\": \"Informasi tambahan jika ada\"\n}\nCari jadwal Public Expose untuk: ${bulanLabel} ${year}`;

        let raw = "";
        let providerUsed = "openai";
        let upstreamErr = null;

        if (env.OPENAI_API_KEY) {
          const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "gpt-4.1-mini",
              messages: [
                { role: "system", content: "Kembalikan HANYA JSON valid tanpa markdown." },
                { role: "user", content: userPrompt }
              ],
              max_tokens: 3000
            })
          });

          if (aiResp.ok) {
            const aiData = await aiResp.json();
            raw = aiData?.choices?.[0]?.message?.content || "";
          } else {
            upstreamErr = `OpenAI error ${aiResp.status}: ${await aiResp.text()}`;
          }
        }

        if (!raw && env.GROK_API_KEY) {
          providerUsed = "grok";
          const grResp = await fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GROK_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "grok-4",
              messages: [
                { role: "system", content: "Kembalikan HANYA JSON valid tanpa markdown." },
                { role: "user", content: userPrompt }
              ],
              max_tokens: 3000
            })
          });

          if (grResp.ok) {
            const grData = await grResp.json();
            raw = grData?.choices?.[0]?.message?.content || "";
          } else {
            const grokErr = `Grok error ${grResp.status}: ${await grResp.text()}`;
            upstreamErr = upstreamErr ? `${upstreamErr} | ${grokErr}` : grokErr;
          }
        }

        if (!raw && env.ANTHROPIC_API_KEY) {
          providerUsed = "claude";
          const clResp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-5",
              max_tokens: 3000,
              system: "Kembalikan HANYA JSON valid tanpa markdown.",
              messages: [{ role: "user", content: userPrompt }]
            })
          });

          if (clResp.ok) {
            const clData = await clResp.json();
            raw = clData?.content?.[0]?.text || "";
          } else {
            const claudeErr = `Claude error ${clResp.status}: ${await clResp.text()}`;
            upstreamErr = upstreamErr ? `${upstreamErr} | ${claudeErr}` : claudeErr;
          }
        }

        if (!raw) {
          return json({ ok: false, error: "Pubex model call failed", details: upstreamErr || "Unknown upstream error" }, 502);
        }

        let parsed = null;
        try {
          parsed = parseJsonFromModel(raw);
        } catch (e) {
          return json({ ok: false, error: "Model JSON parse failed", provider: providerUsed, details: e.message, raw_output: raw }, 502);
        }

        const sources = Array.isArray(parsed?.sumber) ? parsed.sumber : [];
        const rows = Array.isArray(parsed?.data) ? parsed.data : [];
        const batchId = crypto.randomUUID();
        let inserted = 0;
        for (const row of rows) {
          const kode = String(row?.kode_emiten || "").trim().toUpperCase();
          const nama = String(row?.nama_perusahaan || "").trim();
          const tanggal = normalizeIsoDate(String(row?.tanggal || ""));
          const pukul = normalizeWibTime(String(row?.pukul || ""));
          const lokasi = String(row?.lokasi || "").trim();
          const agenda = String(row?.agenda || "").trim();
          if (!kode || !tanggal) continue;

          await env.SSSAHAM_DB.prepare(
            `INSERT INTO pubex (periode, kode_emiten, nama_perusahaan, tanggal, pukul_wib, lokasi, agenda, sumber, ingest_batch_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              periode,
              kode,
              nama || null,
              tanggal,
              pukul || null,
              lokasi || null,
              agenda || null,
              JSON.stringify(sources),
              batchId,
              new Date().toISOString()
            )
            .run();
          inserted++;
        }

        return json({
          ok: true,
          provider: providerUsed,
          periode,
          batch_id: batchId,
          inserted,
          total_model_rows: rows.length,
          sources,
          note: parsed?.catatan || null
        });
      }

      // 7.3 POST /dashboard/ipo/upsert (manual MVP source)
      if (url.pathname === "/dashboard/ipo/upsert" && req.method === "POST") {
        await ensureDashboardTables(env);
        const body = await req.json().catch(() => ({}));
        const entries = Array.isArray(body?.entries) ? body.entries : [];
        if (entries.length === 0) return json({ ok: false, error: "entries[] is required" }, 400);

        let inserted = 0;
        for (const e of entries) {
          const eventDate = normalizeIsoDate(String(e?.event_date || e?.tanggal || ""));
          if (!eventDate) continue;
          const eventTime = normalizeWibTime(String(e?.event_time_wib || e?.pukul || ""));
          const code = String(e?.company_code || e?.kode_emiten || "").trim().toUpperCase() || null;
          const name = String(e?.company_name || e?.nama_perusahaan || "").trim() || null;
          const eventName = String(e?.event_name || "IPO Event").trim() || "IPO Event";
          const location = String(e?.location || e?.lokasi || "").trim() || null;
          const source = String(e?.source || "manual").trim() || "manual";

          await env.SSSAHAM_DB.prepare(
            `INSERT INTO ipo_events (company_code, company_name, event_name, event_date, event_time_wib, location, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(code, name, eventName, eventDate, eventTime, location, source, new Date().toISOString()).run();
          inserted++;
        }
        return json({ ok: true, inserted, total_input: entries.length });
      }

      // 7.35 POST /dashboard/catalyst/sync-ipot
      if (url.pathname === "/dashboard/catalyst/sync-ipot" && req.method === "POST") {
        const auth = requireIdxAdmin(req, env);
        if (!auth.ok) return auth.response;

        const body = await req.json().catch(() => ({}));
        const result = await runIpotCatalystSync(env, {
          fromDate: body?.from || url.searchParams.get("from"),
          toDate: body?.to || url.searchParams.get("to"),
          includeDetail: body?.include_detail !== false,
          detailLimit: Number(body?.detail_limit || url.searchParams.get("detail_limit") || 120)
        });

        return json(result);
      }

      // 7.36 GET /dashboard/catalyst/detail?seq=xxxx
      if (url.pathname === "/dashboard/catalyst/detail" && req.method === "GET") {
        await ensureDashboardTables(env);
        const seq = String(url.searchParams.get("seq") || "").trim();
        if (!seq) return json({ ok: false, error: "seq is required" }, 400);

        const row = await env.SSSAHAM_DB.prepare(
          `SELECT seq, sec, act_type, description_html, description_text, amount, ratio1, ratio2, cum_date, ex_date, rec_date, start_dist_date, end_dist_date, status, fetched_at
           FROM catalyst_ca_detail
           WHERE seq = ?
           LIMIT 1`
        ).bind(seq).first();

        if (!row) return json({ ok: false, error: "detail not found", seq }, 404);
        return json({ ok: true, ...row });
      }

      // 7.4 GET /dashboard/catalyst
      if (url.pathname === "/dashboard/catalyst" && req.method === "GET") {
        await ensureDashboardTables(env);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 300);

        const { results: catalystRows } = await env.SSSAHAM_DB.prepare(
          `SELECT
              e.id,
              e.event_type,
              e.event_subtype,
              e.seq,
              e.event_date,
              e.event_time_wib,
              e.symbol_primary,
              e.symbols_json,
              e.status,
              e.phase,
              e.label,
              e.sector_primary,
              e.created_at,
              d.description_text
           FROM catalyst_events e
           LEFT JOIN catalyst_ca_detail d ON d.seq = e.seq
           ORDER BY e.event_date ASC, COALESCE(e.event_time_wib, '23:59') ASC, e.id DESC
           LIMIT ?`
        ).bind(limit).all();

        const { results: pubexRows } = await env.SSSAHAM_DB.prepare(
          `SELECT id, kode_emiten, nama_perusahaan, tanggal, pukul_wib, lokasi, agenda, sumber, created_at
           FROM pubex
           ORDER BY tanggal ASC, COALESCE(pukul_wib, '23:59') ASC, id DESC
           LIMIT ?`
        ).bind(limit).all();

        const { results: ipoRows } = await env.SSSAHAM_DB.prepare(
          `SELECT id, company_code, company_name, event_name, event_date, event_time_wib, location, source, created_at
           FROM ipo_events
            WHERE COALESCE(source, '') != 'manual-mvp' AND COALESCE(company_code, '') != 'TEST'
           ORDER BY event_date ASC, COALESCE(event_time_wib, '23:59') ASC, id DESC
           LIMIT ?`
        ).bind(limit).all();

        const catalystItems = (catalystRows || []).map((r) => {
          const isRups = String(r.event_type || "").toUpperCase() === "RUPS";
          const symbol = r.symbol_primary || null;
          const subtitle = calcCatalystSubtitle(r);
          const parsedSymbols = (() => {
            try {
              const arr = JSON.parse(r.symbols_json || "[]");
              return Array.isArray(arr) ? arr : [];
            } catch {
              return [];
            }
          })();

          return {
            type: isRups ? "rups" : "ca",
            id: `ipot-${r.id}`,
            seq: r.seq || null,
            symbol,
            symbols: parsedSymbols,
            title: isRups ? `RUPS ${symbol || "Emiten"}` : `Corporate Action ${symbol || "Emiten"}`,
            subtitle: subtitle || (r.event_subtype || null),
            description: r.description_text || r.label || (isRups ? "Jadwal RUPS" : "Corporate Action"),
            phase: r.phase || null,
            status: r.status || null,
            sector: r.sector_primary || null,
            source: "ipot_calca",
            event_date: r.event_date,
            event_time_wib: r.event_time_wib || null,
            event_ts: toEventTimestamp(r.event_date, r.event_time_wib),
            created_at: r.created_at
          };
        });

        const pubexItems = (pubexRows || []).map((r) => ({
          type: "pubex",
          id: `pubex-${r.id}`,
          symbol: r.kode_emiten,
          title: `Public Expose ${r.kode_emiten}`,
          subtitle: r.nama_perusahaan || null,
          description: r.agenda || "Public Expose Emiten",
          location: r.lokasi || null,
          source: r.sumber || null,
          event_date: r.tanggal,
          event_time_wib: r.pukul_wib || null,
          event_ts: toEventTimestamp(r.tanggal, r.pukul_wib),
          created_at: r.created_at
        }));

        const ipoItems = (ipoRows || []).map((r) => ({
          type: "ipo",
          id: `ipo-${r.id}`,
          symbol: r.company_code || null,
          title: r.event_name || "IPO Event",
          subtitle: r.company_name || null,
          description: r.company_code ? `Jadwal IPO ${r.company_code}` : "Jadwal IPO",
          location: r.location || null,
          source: r.source || null,
          event_date: r.event_date,
          event_time_wib: r.event_time_wib || null,
          event_ts: toEventTimestamp(r.event_date, r.event_time_wib),
          created_at: r.created_at
        }));

        const items = [...catalystItems, ...pubexItems, ...ipoItems]
          .sort((a, b) => (a.event_ts - b.event_ts) || (String(a.created_at).localeCompare(String(b.created_at))))
          .slice(0, limit)
          .map(({ event_ts, ...rest }) => rest);

        return json({ ok: true, items, total: items.length });
      }


      // 7. Docs/Health
      if (url.pathname === "/health") return json({ ok: true, service: "api-saham" });

      // PROXY: Integrity Scan (to features-service via Service Binding)
      if (url.pathname === "/integrity-scan") {
        return env.FEATURES_SERVICE.fetch(req);
      }

      // ROUTE: Broker Logo — on-demand fetch + cache in R2
      // GET /broker/logo/MG  → returns JPEG image
      // Flow: check R2 sssaham-emiten/broker/logo/MG.jpg → if miss, fetch from IDX → save to R2 → serve
      if (url.pathname.startsWith("/broker/logo/")) {
        const code = url.pathname.split("/").pop().toUpperCase();
        if (!/^[A-Z0-9]{2,4}$/.test(code)) {
          return new Response("Invalid broker code", { status: 400 });
        }

        const r2Key = `broker/logo/${code}.jpg`;
        const cacheHeaders = {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=2592000, immutable", // 30 days
          "Access-Control-Allow-Origin": "*",
        };

        // 1. Try R2 cache
        const cached = await env.SSSAHAM_EMITEN.get(r2Key);
        if (cached) {
          return new Response(cached.body, { headers: cacheHeaders });
        }

        // 2. Fetch from IDX on-demand
        try {
          const idxUrl = `https://www.idx.co.id/StaticData/Brokers/Logo/${code}.jpg`;
          const idxResp = await fetch(idxUrl, {
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.idx.co.id/" }
          });

          if (!idxResp.ok || !idxResp.headers.get("content-type")?.includes("image")) {
            // Return 1x1 transparent pixel as fallback
            const pixel = new Uint8Array([
              0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,
              0xFF,0xFF,0xFF,0x00,0x00,0x00,0x21,0xF9,0x04,0x01,0x00,0x00,0x00,
              0x00,0x2C,0x00,0x00,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0x02,0x02,
              0x44,0x01,0x00,0x3B
            ]);
            return new Response(pixel, {
              headers: { "Content-Type": "image/gif", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" }
            });
          }

          const imgBuffer = await idxResp.arrayBuffer();

          // 3. Save to R2 (fire-and-forget)
          await env.SSSAHAM_EMITEN.put(r2Key, imgBuffer, {
            httpMetadata: { contentType: "image/jpeg" }
          });

          return new Response(imgBuffer, { headers: cacheHeaders });
        } catch (e) {
          return new Response("Logo fetch error", { status: 502 });
        }
      }

      // ROUTE: Broker Activity — Read BYBROKER data from R2
      // GET /broker-activity?broker=MG&days=1  (single broker, N trading days aggregated)
      // GET /broker-activity?days=1             (all brokers, returns list of available brokers with summary)
      if (url.pathname === "/broker-activity") {
        const broker = (url.searchParams.get("broker") || "").toUpperCase();
        const days = Math.max(1, Math.min(20, parseInt(url.searchParams.get("days")) || 1));
        const wibNow = new Date(Date.now() + 7 * 3600000);
        const wibHour = wibNow.getUTCHours();
        const tradingDays = [];
        let d = new Date(wibNow); d.setUTCHours(0, 0, 0, 0);
        // Skip today if before 17:00 WIB (scraper hasn't run yet)
        if (wibHour < 17) {
          d.setUTCDate(d.getUTCDate() - 1);
        }
        let checked = 0;
        while (tradingDays.length < days && checked < days * 3) {
          const dow = d.getUTCDay();
          if (dow !== 0 && dow !== 6 && !IDX_HOLIDAYS.has(d.toISOString().slice(0, 10))) {
            tradingDays.push(d.toISOString().slice(0, 10));
          }
          d.setUTCDate(d.getUTCDate() - 1);
          checked++;
        }

        if (broker && /^[A-Z0-9]{2,3}$/.test(broker)) {
          const breakdownDaily = url.searchParams.get("breakdown") === "daily";

          // ── Daily breakdown mode: return per-day summaries ──
          if (breakdownDaily) {
            const daily = [];
            for (const date of tradingDays) {
              const [sy, sm, sd] = date.split("-");
              const r2Key = `BYBROKER_${broker}/${sy}/${sm}/${sd}.json`;
              try {
                const obj = await env.RAW_BROKSUM.get(r2Key);
                if (!obj) continue;
                const data = await obj.json();
                let net_val = 0, total_val = 0, buy_val = 0, sell_val = 0;
                let buy_freq = 0, sell_freq = 0;
                const stockSet = new Set();
                for (const s of (data.stocks || [])) {
                  net_val += Number(s.net_val) || 0;
                  total_val += Number(s.total_val) || 0;
                  buy_val += Number(s.buy_val) || 0;
                  sell_val += Number(s.sell_val) || 0;
                  buy_freq += Number(s.buy_freq) || 0;
                  sell_freq += Number(s.sell_freq) || 0;
                  stockSet.add(s.stock_code);
                }
                // Skip days with no actual trades (empty scrape or pre-market file)
                if (total_val === 0 && net_val === 0) continue;
                daily.push({ date, net_val, total_val, buy_val, sell_val, buy_freq, sell_freq, breadth: stockSet.size });
              } catch (e) { /* skip failed date */ }
            }
            return json({ ok: true, broker, days, daily });
          }

          // Single broker — aggregate N days (with R2 cache)
          // Cache key: BYBROKER_{CODE}/cache/{days}D_{latestTradingDay}.json
          // Cache auto-invalidates when a new trading day starts (key changes)
          const cacheKey = `BYBROKER_${broker}/cache/v2_${days}D_${tradingDays[0]}.json`;
          const nocache = url.searchParams.get("nocache") === "true";

          // 1) Try cache first (days > 1 only; days=1 is already a single file read; skip if nocache=true)
          if (days > 1 && !nocache) {
            try {
              const cached = await env.RAW_BROKSUM.get(cacheKey);
              if (cached) {
                const payload = await cached.json();
                payload._cached = true;
                return json(payload);
              }
            } catch (e) { /* cache miss or corrupt — continue to compute */ }
          }

          // 2) Compute from daily files
          const allStocks = new Map();
          const loadedDates = [];
          const dailyNetVol = {}; // stock_code → [net_vol_day0, net_vol_day1, ...] newest first

          for (const date of tradingDays) {
            const [sy, sm, sd] = date.split("-");
            const r2Key = `BYBROKER_${broker}/${sy}/${sm}/${sd}.json`;
            try {
              const obj = await env.RAW_BROKSUM.get(r2Key);
              if (!obj) continue;
              const data = await obj.json();
              loadedDates.push(date);
              for (const s of (data.stocks || [])) {
                if (!allStocks.has(s.stock_code)) {
                  allStocks.set(s.stock_code, {
                    stock_code: s.stock_code,
                    buy_val: 0, sell_val: 0, net_val: 0, total_val: 0,
                    buy_vol: 0, sell_vol: 0, net_vol: 0,
                    buy_freq: 0, sell_freq: 0
                  });
                }
                const agg = allStocks.get(s.stock_code);
                agg.buy_val += Number(s.buy_val) || 0;
                agg.sell_val += Number(s.sell_val) || 0;
                agg.net_val += Number(s.net_val) || 0;
                agg.total_val += Number(s.total_val) || 0;
                agg.buy_vol += Number(s.buy_vol) || 0;
                agg.sell_vol += Number(s.sell_vol) || 0;
                agg.net_vol += Number(s.net_vol) || 0;
                agg.buy_freq += Number(s.buy_freq) || 0;
                agg.sell_freq += Number(s.sell_freq) || 0;
                // Track daily net_vol for streak computation
                if (!dailyNetVol[s.stock_code]) dailyNetVol[s.stock_code] = [];
                dailyNetVol[s.stock_code].push(Number(s.net_vol) || 0);
              }
            } catch (e) { console.warn(`[broker-activity] R2 read error ${r2Key}: ${e.message}`); }
          }

          // Compute streak: consecutive same-direction days from most recent
          for (const [code, agg] of allStocks) {
            const daily = dailyNetVol[code] || [];
            let streak = 0;
            if (daily.length > 0 && daily[0] !== 0) {
              const dir = daily[0] > 0 ? 1 : -1;
              streak = dir; // day 0 counts
              for (let i = 1; i < daily.length; i++) {
                const d = daily[i] > 0 ? 1 : daily[i] < 0 ? -1 : 0;
                if (d === dir) streak += dir;
                else break;
              }
            }
            agg.streak = streak; // positive = buy streak, negative = sell streak
          }

          const stocks = Array.from(allStocks.values())
            .sort((a, b) => Math.abs(b.net_val) - Math.abs(a.net_val));

          const payload = {
            ok: true, broker, days,
            dates_loaded: loadedDates,
            breadth: stocks.length,
            stocks
          };

          // 3) Write cache (non-blocking, days > 1 only)
          if (days > 1 && loadedDates.length > 0) {
            try {
              await env.RAW_BROKSUM.put(cacheKey, JSON.stringify(payload), {
                httpMetadata: { contentType: "application/json" }
              });
            } catch (e) { console.warn(`[broker-activity] cache write error: ${e.message}`); }
          }

          return json(payload);

        } else {
          // All brokers — list available for first trading day
          const targetDate = tradingDays[0];
          if (!targetDate) return json({ ok: false, error: "No trading day found" });
          const [sy, sm, sd] = targetDate.split("-");
          const prefix = `BYBROKER_`;
          const brokers = [];

          try {
            const listed = await env.RAW_BROKSUM.list({ prefix });
            const seen = new Set();
            for (const obj of (listed.objects || [])) {
              // key = BYBROKER_MG/2026/03/05.json
              const m = obj.key.match(/^BYBROKER_([A-Z0-9]{2,3})\//);
              if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                brokers.push(m[1]);
              }
            }
          } catch (e) { /* ignore */ }

          return json({ ok: true, date: targetDate, brokers: brokers.sort(), count: brokers.length });
        }
      }

      // ── Broker Trailing: per-stock per-day series for a broker ──
      if (url.pathname === "/broker-activity/trailing" && req.method === "GET") {
        const broker = (url.searchParams.get("broker") || "").toUpperCase();
        if (!broker || !/^[A-Z0-9]{2,3}$/.test(broker)) {
          return json({ error: "Missing or invalid ?broker= param" }, 400);
        }
        const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get("days")) || 10));

        // Build trading-day list (newest first)
        const wibNow = new Date(Date.now() + 7 * 3600000);
        const wibHourT = wibNow.getUTCHours();
        const tradingDays = [];
        let d = new Date(wibNow); d.setUTCHours(0, 0, 0, 0);
        // Skip today if before 17:00 WIB (scraper hasn't run yet)
        if (wibHourT < 17) {
          d.setUTCDate(d.getUTCDate() - 1);
        }
        let checked = 0;
        while (tradingDays.length < days && checked < days * 3) {
          const dow = d.getUTCDay();
          if (dow !== 0 && dow !== 6 && !IDX_HOLIDAYS.has(d.toISOString().slice(0, 10))) {
            tradingDays.push(d.toISOString().slice(0, 10));
          }
          d.setUTCDate(d.getUTCDate() - 1);
          checked++;
        }

        // Cache key
        const cacheKey = `BYBROKER_${broker}/cache/trailing_${days}D_${tradingDays[0]}.json`;
        const nocache = url.searchParams.get("nocache") === "true";
        if (!nocache) {
          try {
            const cached = await env.RAW_BROKSUM.get(cacheKey);
            if (cached) {
              const payload = await cached.json();
              payload._cached = true;
              return json(payload);
            }
          } catch (_) { /* miss */ }
        }

        // Fetch each day's raw data — newest first, reverse to chronological for output
        const daysChronological = [...tradingDays].reverse(); // oldest first
        // stockSeries: { "BBRI": [{ date, buy_val, sell_val, net_val, net_vol, buy_freq, sell_freq }] }
        const stockSeries = {};
        const loadedDates = [];

        for (const date of daysChronological) {
          const [sy, sm, sd] = date.split("-");
          const r2Key = `BYBROKER_${broker}/${sy}/${sm}/${sd}.json`;
          try {
            const obj = await env.RAW_BROKSUM.get(r2Key);
            if (!obj) continue;
            const data = await obj.json();
            if (!data.stocks || data.stocks.length === 0) continue;
            loadedDates.push(date);
            for (const s of data.stocks) {
              if (!stockSeries[s.stock_code]) stockSeries[s.stock_code] = [];
              stockSeries[s.stock_code].push({
                date,
                buy_val: Number(s.buy_val) || 0,
                sell_val: Number(s.sell_val) || 0,
                net_val: Number(s.net_val) || 0,
                net_vol: Number(s.net_vol) || 0,
                buy_freq: Number(s.buy_freq) || 0,
                sell_freq: Number(s.sell_freq) || 0,
              });
            }
          } catch (e) { /* skip */ }
        }

        // Add cumulative_net to each stock series + compute total_net
        const stockSummary = [];
        for (const [code, series] of Object.entries(stockSeries)) {
          let cumNet = 0;
          let totalBuy = 0, totalSell = 0;
          for (const pt of series) {
            cumNet += pt.net_val;
            pt.cumulative_net = cumNet;
            totalBuy += pt.buy_val;
            totalSell += pt.sell_val;
          }
          stockSummary.push({
            stock_code: code,
            total_net: cumNet,
            total_buy: totalBuy,
            total_sell: totalSell,
            days_active: series.length,
          });
        }

        // Sort by absolute net descending
        stockSummary.sort((a, b) => Math.abs(b.total_net) - Math.abs(a.total_net));

        const payload = {
          ok: true,
          broker,
          days,
          dates: loadedDates,
          stock_summary: stockSummary,
          series: stockSeries,
        };

        // Write cache (non-blocking)
        if (loadedDates.length > 1) {
          try {
            await env.RAW_BROKSUM.put(cacheKey, JSON.stringify(payload), {
              httpMetadata: { contentType: "application/json" }
            });
          } catch (e) { /* ignore */ }
        }

        return json(payload);
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
  isHolidayUTC,
  isNonTradingDayUTC,
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
