/**
 * @worker sector-scrapper
 * @objective Captures per-sector frequency & price-range snapshots from iPOT via WebSocket,
 *            dual-writes JSONL records to R2 at per-symbol and per-sector-aggregate paths.
 *
 * @architecture
 *   HTTP / Cron  →  enqueue per-sector messages  →  Cloudflare Queue
 *   Queue consumer  →  per-sector: TopStock query + parallel TradedSummary  →  R2 write
 *
 * @endpoints
 *   GET /health                      → liveness probe (public)
 *   GET /sector-tape                 → enqueue all (or selected) sectors → 202 (INTERNAL_KEY required)
 *   GET /sector-tape/run             → synchronous single-run (debug, INTERNAL_KEY required)
 *   GET /sector-tape/status          → read latest run summary from KV (INTERNAL_KEY required)
 *   GET /sector/latest               → latest snapshot record per symbol (INTERNAL_KEY required)
 *   GET /sector/digest               → freq_tx + growth_pct digest per symbol (INTERNAL_KEY required)
 *   GET /sector/digest/batch         → digest for all symbols in a sector (INTERNAL_KEY required)
 *
 * @r2_paths
 *   sector/{SECTOR}/{SYMBOL}/{YYYY}/{MM}/{DD}.jsonl  (per-symbol)
 *   sector/{SECTOR}/{YYYY}/{MM}/{DD}.jsonl           (per-sector aggregate)
 *
 * @triggers
 *   - http: yes
 *   - cron:  "* 1,2,3,4,5,6,7,8,9,10 * * 1-5"  (every minute UTC 01-10, Mon-Fri)
 *            Runtime time-guard enforces WIB schedule:
 *              08:30-11:00 WIB  → every 1 minute
 *              11:00-12:00 WIB  → every 5 minutes
 *              12:00-13:00 WIB  → OFF (lunch break)
 *              13:00-17:00 WIB  → every 5 minutes
 *   - queue: sector-tape-queue
 *
 * @io
 *   reads:  KV(SSSAHAM_WATCHLIST – appsession cache)
 *   writes: R2(FOOTPRINT_BUCKET), KV(SSSAHAM_WATCHLIST – run summary), Queue(SECTOR_TAPE_QUEUE)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SECTOR_LIST = [
    "IDXBASIC",
    "IDXENERGY",
    "IDXINDUST",
    "IDXNONCYC",
    "IDXCYCLIC",
    "IDXHEALTH",
    "IDXFINANCE",
    "IDXPROPERT",
    "IDXTECHNO",
    "IDXINFRA",
    "IDXTRANS"
];

const WORKER_VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseSectorList(raw) {
    if (!raw || typeof raw !== "string") return DEFAULT_SECTOR_LIST;
    const out = raw.split(",")
        .map(s => String(s || "").trim().toUpperCase())
        .filter(Boolean);
    return out.length ? Array.from(new Set(out)) : DEFAULT_SECTOR_LIST;
}

function toPositiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/** Parse pipe-delimited SS2 data string from iPOT stream.
 *  Fields: ...|...|symbol|board|...|high|low|last|...|...|freq|...
 *  Index:       0   1     2     3   4    5    6    7    8   9   10
 */
function parseSS2DataString(raw) {
    if (!raw || typeof raw !== "string") return null;
    const t = raw.split("|").map(x => String(x || "").trim());
    if (t.length < 11) return null;

    const symbol = String(t[2] || "").toUpperCase();
    const board  = String(t[3] || "").toUpperCase();
    const high   = toPositiveNumber(t[5]);
    const low    = toPositiveNumber(t[6]);
    const last   = toPositiveNumber(t[7]);
    const freq   = toPositiveNumber(t[10]);
    const highOut = (high !== null) ? high : Math.max(last || 0, low || 0);

    return { symbol, board, price_high: highOut, price_low: low, price_last: last, freq_tx: freq };
}

/** Parse one row of en_qu_TradedSummary response: PRICE|B_LOT|S_LOT|B_FREQ|S_FREQ */
function parseTradedSummaryLine(raw) {
    if (!raw || typeof raw !== "string") return null;
    const t = raw.split("|").map(x => String(x || "").trim());
    if (t.length < 5) return null;

    const price = toPositiveNumber(t[0]);
    const bLot  = toPositiveNumber(t[1]);
    const sLot  = toPositiveNumber(t[2]);
    const bFreq = toPositiveNumber(t[3]);
    const sFreq = toPositiveNumber(t[4]);
    if (price === null) return null;

    return {
        price,
        b_lot: bLot,
        s_lot: sLot,
        t_lot: (Number.isFinite(bLot) ? bLot : 0) + (Number.isFinite(sLot) ? sLot : 0),
        b_freq: bFreq,
        s_freq: sFreq
    };
}

/** Read-append-write a JSONL file in R2 (atomic-ish per invocation). */
async function appendJsonlBatch(r2, key, lines) {
    if (!r2 || !key || !Array.isArray(lines) || lines.length === 0) return;
    let existing = "";
    try {
        const obj = await r2.get(key);
        if (obj) existing = await obj.text();
    } catch (_) { }

    const appendBody = lines.map(l => `${l}\n`).join("");
    const body = existing ? `${existing}${appendBody}` : appendBody;
    await r2.put(key, body, {
        httpMetadata: { contentType: "application/x-ndjson" }
    });
}

function withCors(headers = {}) {
    return {
        ...headers,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };
}

function requireKey(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!env.INTERNAL_KEY) return null;
    if (key !== env.INTERNAL_KEY) {
        return new Response(
            JSON.stringify({ ok: false, error: "Forbidden", reason: "INVALID_KEY" }),
            { status: 403, headers: withCors({ "Content-Type": "application/json" }) }
        );
    }
    return null;
}

function makeWebSocketKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

// ─────────────────────────────────────────────────────────────────────────────
// iPOT Session Helpers (shared KV with broksum-scrapper)
// ─────────────────────────────────────────────────────────────────────────────

async function getIpotAppSession(env) {
    const cached = await env.SSSAHAM_WATCHLIST.get("IPOT_APPSESSION");
    if (cached) return cached;

    const url    = env.IPOT_APPSESSION_URL || "https://indopremier.com/ipc/appsession.js";
    const origin = env.IPOT_ORIGIN         || "https://indopremier.com";

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 5000);

    try {
        const resp = await fetch(url, {
            headers: {
                "Accept": "*/*",
                "User-Agent": "sector-scrapper/1.0",
                "Origin": origin,
                "Referer": origin + "/"
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
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
            if (m && m[1]) { token = m[1]; break; }
        }
        if (!token) {
            const near = text.match(/appsession[^A-Za-z0-9\-_]{0,30}([A-Za-z0-9\-_]{16,128})/i);
            if (near) token = near[1];
        }
        if (!token) throw new Error(`could not parse appsession from ${url}`);

        await env.SSSAHAM_WATCHLIST.put("IPOT_APPSESSION",        token, { expirationTtl: 600 });
        await env.SSSAHAM_WATCHLIST.put("IPOT_APPSESSION_BACKUP",  token, { expirationTtl: 21600 });
        return token;
    } catch (e) {
        clearTimeout(timeoutId);
        const backup = await env.SSSAHAM_WATCHLIST.get("IPOT_APPSESSION_BACKUP");
        if (backup) {
            console.warn(`getIpotAppSession fetch failed, using stale backup: ${e.message}`);
            return backup;
        }
        throw e;
    }
}

async function clearIpotAppSession(env) {
    try {
        await env.SSSAHAM_WATCHLIST.delete("IPOT_APPSESSION");
        await env.SSSAHAM_WATCHLIST.delete("IPOT_APPSESSION_BACKUP");
    } catch { }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket helpers
// ─────────────────────────────────────────────────────────────────────────────

async function openIpotWs(env) {
    const headers = {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: env.IPOT_ORIGIN || "https://indopremier.com",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": makeWebSocketKey(),
        "User-Agent": "sector-scrapper/1.0"
    };

    const appsession = await getIpotAppSession(env);
    const wsBase  = env.IPOT_WS_HTTP_BASE || "https://ipotapp.ipot.id/socketcluster/";
    const wsUrl   = new URL(wsBase);
    wsUrl.searchParams.set("appsession", appsession);
    const httpUrl = wsUrl.toString().startsWith("wss://")
        ? "https://" + wsUrl.toString().slice("wss://".length)
        : wsUrl.toString().startsWith("ws://")
            ? "http://" + wsUrl.toString().slice("ws://".length)
            : wsUrl.toString();

    const resp = await fetch(httpUrl, { headers });
    if (!resp.webSocket) throw new Error(`WS upgrade failed: ${resp.status}`);
    const ws = resp.webSocket;
    ws.accept();
    try { ws.send(JSON.stringify({ event: "#handshake", data: { authToken: env.IPOT_AUTH_TOKEN || null }, cid: 1 })); } catch { }
    return ws;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: run one sector → returns summary + records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens a fresh WS connection and scrapes one sector.
 *
 * @param {object} env          - Cloudflare env bindings
 * @param {object} opts
 * @param {string}  opts.sector
 * @param {string}  opts.date          - YYYY-MM-DD (UTC today if omitted)
 * @param {number}  opts.topN
 * @param {number}  opts.idleMs
 * @param {number}  opts.maxMs
 * @param {boolean} opts.includeLevels
 * @param {number}  opts.levelLimit
 * @param {number}  opts.levelIdleMs
 * @param {number}  opts.levelMaxMs
 * @returns {{ sector, date, records, top_count, captured_count, level_count, symbols }}
 */
async function runSectorJob(env, {
    sector,
    date        = null,
    topN        = 30,
    idleMs      = 1200,
    maxMs       = 7000,
    includeLevels = true,
    levelLimit  = 20,
    levelIdleMs = 700,
    levelMaxMs  = 2200
}) {
    const now  = new Date();
    const yyyy = String(date ? date.slice(0, 4)  : now.getUTCFullYear());
    const mm   = String(date ? date.slice(5, 7)  : now.getUTCMonth() + 1).padStart(2, "0");
    const dd   = String(date ? date.slice(8, 10) : now.getUTCDate()).padStart(2, "0");
    const resolvedDate = date || `${yyyy}-${mm}-${dd}`;

    // ── Open WebSocket (retry once on session failure) ──────────────────────
    let ws;
    try {
        ws = await openIpotWs(env);
    } catch {
        await clearIpotAppSession(env);
        ws = await openIpotWs(env);
    }

    let cid    = 100;
    let cmdid  = 100;
    const nextCid   = () => ++cid;
    const nextCmdid = () => ++cmdid;

    // ── Generic query helper ─────────────────────────────────────────────────
    const runQueryRecords = async (queryParam, recordExtractor, opts = {}) => {
        const queryCmdid    = nextCmdid();
        const queryCid      = nextCid();
        const localIdleMs   = Number(opts.idleMs     || 700);
        const localMaxMs    = Number(opts.maxMs      || 2500);
        const localEmptyMs  = Number(opts.emptyIdleMs || 900);
        const records       = [];

        let gotRes  = false;
        let resAt   = null;
        let lastAt  = Date.now();
        const startedAt = Date.now();

        const onMsg = (ev) => {
            lastAt = Date.now();
            const txt = typeof ev.data === "string" ? ev.data : "";
            if (txt === "#1") { try { ws.send("#2"); } catch { } return; }
            let j; try { j = JSON.parse(txt); } catch { return; }

            const msgCmdid = Number(j?.data?.cmdid);
            if (j?.event === "record" && msgCmdid === Number(queryCmdid)) {
                const payload = recordExtractor(j?.data?.data || {});
                if (payload !== undefined && payload !== null) records.push(payload);
            }
            if (j?.event === "res" && msgCmdid === Number(queryCmdid)) {
                gotRes = true; resAt = Date.now();
            }
        };

        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ event: "cmd", data: { cmdid: queryCmdid, param: queryParam }, cid: queryCid }));

        while (true) {
            const nowMs = Date.now();
            if (nowMs - startedAt > localMaxMs) break;
            if (gotRes && resAt && (nowMs - resAt) > localIdleMs) break;
            if (!gotRes && records.length === 0 && (nowMs - lastAt) > localEmptyMs) break;
            await new Promise(r => setTimeout(r, 50));
        }

        ws.removeEventListener("message", onMsg);
        return records;
    };

    try {
        // ── Step 1: TopStock query + SS2 stream ──────────────────────────────
        const symbols      = new Set();
        const ss2BySymbol  = new Map();

        const queryCmdid = nextCmdid();
        const queryCid   = nextCid();
        let gotRes   = false;
        let resAt    = null;
        let lastAt   = Date.now();
        const startedAt = Date.now();

        const onMsg = (ev) => {
            lastAt = Date.now();
            const txt = typeof ev.data === "string" ? ev.data : "";
            if (txt === "#1") { try { ws.send("#2"); } catch { } return; }
            let j; try { j = JSON.parse(txt); } catch { return; }

            const msgCmdid = Number(j?.data?.cmdid);
            if (j?.event === "record" && msgCmdid === Number(queryCmdid)) {
                const sym = String(j?.data?.data?.get_top_stock || "").trim().toUpperCase();
                if (sym) symbols.add(sym);
            }
            if (j?.event === "stream") {
                const stream = j?.data || {};
                const rtype  = String(stream?.rtype || "").toUpperCase();
                const code   = String(stream?.code || stream?.data?.code || "").toUpperCase();
                const raw    = stream?.data?.data;
                if (rtype === "SS2" && code && typeof raw === "string") {
                    ss2BySymbol.set(code, { raw, board: String(stream?.data?.board || "").toUpperCase(), ts: new Date().toISOString() });
                }
            }
            if (j?.event === "res" && msgCmdid === Number(queryCmdid)) {
                gotRes = true; resAt = Date.now();
            }
        };

        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({
            event: "cmd",
            data: {
                cmdid: queryCmdid,
                param: {
                    cmd: "query", service: "midata",
                    param: {
                        source: "datafeed",
                        index:  "en_qu_get_top_stock",
                        args:   ["TopStock", sector, "pchg", "DESC", topN]
                    }
                }
            },
            cid: queryCid
        }));

        const settleAfterResMs = Math.max(500, Math.min(2500, idleMs));
        const emptyIdleMs      = Math.max(500, Math.floor(idleMs * 0.8));

        while (true) {
            const nowMs = Date.now();
            if (nowMs - startedAt > maxMs) break;
            if (gotRes && resAt && (nowMs - resAt) > settleAfterResMs) break;
            if (!gotRes && symbols.size === 0 && (nowMs - lastAt) > emptyIdleMs) break;
            await new Promise(r => setTimeout(r, 50));
        }

        ws.removeEventListener("message", onMsg);

        // ── Step 2: Parallel TradedSummary per symbol ────────────────────────
        const levelMap = new Map();
        if (includeLevels && symbols.size > 0) {
            const LEVEL_CONCURRENCY = 8;
            const symList = Array.from(symbols);
            let symIdx = 0;

            const levelWorker = async () => {
                while (symIdx < symList.length) {
                    const sym = symList[symIdx++];
                    const lines = await runQueryRecords(
                        {
                            service: "midata",
                            cmd:     "query",
                            param: {
                                source: "datafeed",
                                index:  "en_qu_TradedSummary",
                                args:   [sym]
                            }
                        },
                        row => row?.en_qu_tradedsummary,
                        {
                            idleMs:      levelIdleMs,
                            maxMs:       levelMaxMs,
                            emptyIdleMs: Math.max(350, Math.floor(levelIdleMs * 0.75))
                        }
                    );
                    const levels = lines
                        .map(parseTradedSummaryLine)
                        .filter(Boolean)
                        .slice(0, levelLimit);
                    if (levels.length) levelMap.set(sym, levels);
                }
            };

            await Promise.all(
                Array.from({ length: Math.min(LEVEL_CONCURRENCY, symList.length) }, levelWorker)
            );
        }

        // ── Step 3: Build records ────────────────────────────────────────────
        const records = [];
        for (const sym of symbols) {
            const payload = ss2BySymbol.get(sym);
            const levels  = levelMap.get(sym) || [];
            let out = null;

            // Compute CVD from TradedSummary levels: Σ(b_lot - s_lot)
            let cvd_lot = null;
            if (levels.length > 0) {
                cvd_lot = levels.reduce((sum, lv) => {
                    const bl = Number(lv.b_lot || 0);
                    const sl = Number(lv.s_lot || 0);
                    return sum + (Number.isFinite(bl) ? bl : 0) - (Number.isFinite(sl) ? sl : 0);
                }, 0);
            }

            if (payload) {
                const parsed = parseSS2DataString(payload.raw);
                if (parsed && Number.isFinite(parsed.freq_tx) && parsed.freq_tx >= 0) {
                    if (!parsed.symbol) parsed.symbol = sym;
                    out = {
                        ts:          payload.ts,
                        date:        resolvedDate,
                        sector,
                        symbol:      parsed.symbol || sym,
                        board:       parsed.board  || payload.board || null,
                        price_last:  parsed.price_last,
                        price_high:  parsed.price_high,
                        price_low:   parsed.price_low,
                        freq_tx:     parsed.freq_tx,
                        cvd_lot,
                        levels,
                        raw:         payload.raw,
                        source:      "ws:ss2"
                    };
                }
            }

            // Fallback: no SS2 but TradedSummary levels available
            if (!out && levels.length > 0) {
                const prices = levels.map(l => Number(l?.price)).filter(n => Number.isFinite(n));
                out = {
                    ts:         new Date().toISOString(),
                    date:       resolvedDate,
                    sector,
                    symbol:     sym,
                    board:      null,
                    price_last: prices.length ? prices[0]           : null,
                    price_high: prices.length ? Math.max(...prices) : null,
                    price_low:  prices.length ? Math.min(...prices) : null,
                    freq_tx:    levels.reduce((sum, l) => {
                        const bf = Number(l?.b_freq || 0);
                        const sf = Number(l?.s_freq || 0);
                        return sum + (Number.isFinite(bf) ? bf : 0) + (Number.isFinite(sf) ? sf : 0);
                    }, 0),
                    cvd_lot,
                    levels,
                    raw:    null,
                    source: "ws:tradedsummary"
                };
            }

            if (out) records.push(out);
        }

        return {
            sector,
            date:            resolvedDate,
            yyyy, mm, dd,
            top_count:       symbols.size,
            captured_count:  records.length,
            level_count:     Array.from(levelMap.values()).reduce((s, a) => s + a.length, 0),
            symbols:         Array.from(symbols),
            records
        };
    } finally {
        try { ws && ws.close && ws.close(); } catch { }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// R2 Write
// ─────────────────────────────────────────────────────────────────────────────

async function writeSectorRecordsToR2(env, sectorResult) {
    if (!env.FOOTPRINT_BUCKET) throw new Error("FOOTPRINT_BUCKET binding not found");
    const { sector, yyyy, mm, dd, records } = sectorResult;

    // Dedup within this result — key: symbol + freq_tx + price_last + 1-minute ts bucket (PRD §7.4)
    const dedup = new Map();
    for (const r of records) {
        const tsBucket = r.ts ? r.ts.slice(0, 16) : ""; // truncate to minute: "2026-02-25T10:03"
        dedup.set(`${r.symbol}|${r.freq_tx}|${r.price_last}|${tsBucket}`, r);
    }
    const finalRecords = Array.from(dedup.values());

    const linesByKey = new Map();
    for (const rec of finalRecords) {
        const sym = String(rec.symbol || "").toUpperCase();
        if (!sym) continue;
        const symbolKey = `sector/${sector}/${sym}/${yyyy}/${mm}/${dd}.jsonl`;
        const sectorKey = `sector/${sector}/${yyyy}/${mm}/${dd}.jsonl`;
        const line      = JSON.stringify(rec);

        if (!linesByKey.has(symbolKey)) linesByKey.set(symbolKey, []);
        linesByKey.get(symbolKey).push(line);

        if (!linesByKey.has(sectorKey)) linesByKey.set(sectorKey, []);
        linesByKey.get(sectorKey).push(line);
    }

    let writtenKeys = 0;
    for (const [key, lines] of linesByKey.entries()) {
        await appendJsonlBatch(env.FOOTPRINT_BUCKET, key, lines);
        writtenKeys++;
    }
    return { written_keys: writtenKeys, written_records: finalRecords.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue message builders
// ─────────────────────────────────────────────────────────────────────────────

function buildSectorMessages(sectors, opts) {
    return sectors.map(sector => ({
        body: { sector, ...opts }
    }));
}

async function enqueueSectors(env, sectors, opts) {
    if (!env.SECTOR_TAPE_QUEUE) throw new Error("SECTOR_TAPE_QUEUE binding not found");
    const messages = buildSectorMessages(sectors, opts);
    // Cloudflare Queues: sendBatch accepts array of { body, contentType?, delaySeconds? }
    await env.SECTOR_TAPE_QUEUE.sendBatch(messages);
    return messages.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Digest Helpers (PRD §8 Phase 4 — Consumption)
// ─────────────────────────────────────────────────────────────────────────────

/** Returns WIB date string YYYY-MM-DD for today. */
function getWibDateString() {
    const now = new Date();
    // WIB = UTC+7
    const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const yyyy = wib.getUTCFullYear();
    const mm   = String(wib.getUTCMonth() + 1).padStart(2, "0");
    const dd   = String(wib.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Read all JSONL records for sector/symbol/date from R2.
 * Returns array of parsed records (empty array if not found).
 */
async function readSectorRecords(env, sector, symbol, date) {
    const [yyyy, mm, dd] = date.split("-");
    const key = `sector/${sector}/${symbol}/${yyyy}/${mm}/${dd}.jsonl`;
    try {
        const obj = await env.FOOTPRINT_BUCKET.get(key);
        if (!obj) return [];
        const text  = await obj.text();
        const lines = text.split("\n").filter(l => l.trim());
        const records = [];
        for (const line of lines) {
            try { records.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
        }
        return records;
    } catch { return []; }
}

/**
 * Compute freq_tx (sum of levels) + growth_pct (first vs last snapshot price)
 * from an array of records for one symbol.
 *
 * freq_tx:   Σ(b_freq + s_freq) across ALL levels in the LATEST snapshot
 *            — this is the most accurate market total (avoids double-count)
 * growth_pct: (price_last_now − price_last_first) / price_last_first × 100
 *
 * @param  {object[]} records  — array of parsed JSONL records, any order
 * @returns {object|null}
 */
function computeDigest(records) {
    if (!records || records.length === 0) return null;

    // Sort ascending by ts
    const sorted = [...records].sort((a, b) =>
        new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
    const first = sorted[0];
    const last  = sorted[sorted.length - 1];

    // ── FREQ: sum levels from latest snapshot ─────────────────────────────
    let freq_tx     = null;
    let freq_source = "snapshot_field";
    if (Array.isArray(last.levels) && last.levels.length > 0) {
        freq_tx     = last.levels.reduce((sum, lv) =>
            sum + (Number(lv.b_freq) || 0) + (Number(lv.s_freq) || 0), 0);
        freq_source = "levels_sum";
    } else if (last.freq_tx != null) {
        freq_tx = Number(last.freq_tx) || 0;
    }

    // ── PRICE ─────────────────────────────────────────────────────────────
    const price_open = first.price_last ?? null;   // first snapshot of day = open proxy
    const price_last = last.price_last  ?? null;   // latest = current/close proxy
    const price_high = last.price_high  ?? null;
    const price_low  = last.price_low   ?? null;

    // ── GROWTH ───────────────────────────────────────────────────────────
    let growth_pct = null;
    if (price_open != null && price_last != null && price_open !== 0) {
        growth_pct = parseFloat(
            (((price_last - price_open) / price_open) * 100).toFixed(4)
        );
    }

    // ── CVD from TradedSummary levels ─────────────────────────────────
    // cvd_lot: latest snapshot's net buy-sell lots Σ(b_lot - s_lot)
    // cvd_delta: change in cvd_lot from first to last snapshot (intraday momentum)
    const cvd_lot   = last.cvd_lot  ?? null;
    const cvd_first = first.cvd_lot ?? null;
    let cvd_delta = null;
    if (cvd_lot !== null && cvd_first !== null) {
        cvd_delta = cvd_lot - cvd_first;
    }

    return {
        freq_tx,
        freq_source,
        price_open,
        price_last,
        price_high,
        price_low,
        growth_pct,
        cvd_lot,
        cvd_delta,
        snapshots_count: sorted.length,
        ts_first: first.ts,
        ts_last:  last.ts,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Entry
// ─────────────────────────────────────────────────────────────────────────────

export default {
    // ── HTTP handler ──────────────────────────────────────────────────────────
    async fetch(request, env, ctx) {
        const url  = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: withCors() });
        }

        // ── GET /health ──────────────────────────────────────────────────────
        if (path === "/health") {
            return new Response(JSON.stringify({
                ok: true,
                timestamp: new Date().toISOString(),
                service:   "sector-scrapper",
                version:   WORKER_VERSION
            }), { headers: withCors({ "Content-Type": "application/json" }) });
        }

        // All other endpoints require INTERNAL_KEY
        const keyErr = requireKey(request, env);
        if (keyErr) return keyErr;

        // ── GET /sector-tape ─────────────────────────────────────────────────
        // Enqueues per-sector messages → returns 202 immediately.
        if (path === "/sector-tape") {
            const sectors     = parseSectorList(url.searchParams.get("sectors") || env.SECTOR_LIST || "");
            const topN        = clampInt(url.searchParams.get("top_n"),         1, 200, clampInt(env.TOP_N_PER_SECTOR,          1, 200, 30));
            const includeLvl  = url.searchParams.get("include_levels") !== "false";
            const levelLimit  = clampInt(url.searchParams.get("level_limit"),   1, 100, clampInt(env.SECTOR_TAPE_LEVEL_LIMIT,   1, 100, 20));
            const idleMs      = clampInt(url.searchParams.get("idle_ms"),       300, 5000, clampInt(env.SECTOR_TAPE_IDLE_MS,    300, 5000, 1200));
            const maxMs       = clampInt(url.searchParams.get("max_ms"),        1500, 15000, clampInt(env.SECTOR_TAPE_MAX_MS,   1500, 15000, 7000));
            const levelIdleMs = clampInt(url.searchParams.get("level_idle_ms"), 200, 4000, clampInt(env.SECTOR_TAPE_LEVEL_IDLE_MS, 200, 4000, 700));
            const levelMaxMs  = clampInt(url.searchParams.get("level_max_ms"),  500, 8000, clampInt(env.SECTOR_TAPE_LEVEL_MAX_MS,  500, 8000, 2200));
            const write       = url.searchParams.get("write") !== "false";

            const opts = { topN, write, idleMs, maxMs, includeLevels: includeLvl, levelLimit, levelIdleMs, levelMaxMs };
            const enqueued = await enqueueSectors(env, sectors, opts);

            return new Response(JSON.stringify({
                ok:       true,
                enqueued,
                sectors,
                opts
            }), { status: 202, headers: withCors({ "Content-Type": "application/json" }) });
        }

        // ── GET /sector-tape/run ─────────────────────────────────────────────
        // Synchronous single-sector (or all-sectors) run. Intended for debugging only.
        // WARNING: May hit Cloudflare CPU limits for large multi-sector runs.
        if (path === "/sector-tape/run") {
            const sectorsParam = url.searchParams.get("sectors") || env.SECTOR_LIST || "";
            const sectors      = parseSectorList(sectorsParam);
            const topN         = clampInt(url.searchParams.get("top_n"),         1, 200, 30);
            const includeLvl   = url.searchParams.get("include_levels") !== "false";
            const levelLimit   = clampInt(url.searchParams.get("level_limit"),   1, 100, 20);
            const idleMs       = clampInt(url.searchParams.get("idle_ms"),       300, 5000, 1200);
            const maxMs        = clampInt(url.searchParams.get("max_ms"),        1500, 15000, 7000);
            const levelIdleMs  = clampInt(url.searchParams.get("level_idle_ms"), 200, 4000, 700);
            const levelMaxMs   = clampInt(url.searchParams.get("level_max_ms"),  500, 8000, 2200);
            const write        = url.searchParams.get("write") !== "false";

            try {
                const sectorSummaries = [];
                let totalRecords = 0;
                let totalWrittenKeys = 0;

                for (const sector of sectors) {
                    const result = await runSectorJob(env, {
                        sector, topN, idleMs, maxMs,
                        includeLevels: includeLvl, levelLimit, levelIdleMs, levelMaxMs
                    });

                    let writtenKeys = 0;
                    if (write) {
                        const w = await writeSectorRecordsToR2(env, result);
                        writtenKeys = w.written_keys;
                    }

                    sectorSummaries.push({
                        sector:         result.sector,
                        top_count:      result.top_count,
                        captured_count: result.captured_count,
                        level_count:    result.level_count,
                        written_keys:   writtenKeys,
                        sample_symbols: result.symbols.slice(0, 10)
                    });
                    totalRecords     += result.captured_count;
                    totalWrittenKeys += writtenKeys;
                }

                return new Response(JSON.stringify({
                    ok: true,
                    date: new Date().toISOString().slice(0, 10),
                    sectors,
                    top_n:          topN,
                    include_levels: includeLvl,
                    level_limit:    levelLimit,
                    write,
                    records:        totalRecords,
                    written_keys:   totalWrittenKeys,
                    sector_summary: sectorSummaries
                }), { headers: withCors({ "Content-Type": "application/json" }) });
            } catch (e) {
                return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) });
            }
        }

        // ── GET /sector-tape/status ──────────────────────────────────────────
        // Read last-run summary persisted to KV by the queue consumer.
        // Includes observability metrics: symbol_coverage_pct, sector_coverage (PRD §9)
        if (path === "/sector-tape/status") {
            const raw = await env.SSSAHAM_WATCHLIST.get("SECTOR_TAPE_LAST_RUN", { type: "json" }) || {};
            // Compute coverage metrics
            const sectorEntries = Object.values(raw).filter(v => v && typeof v === "object" && v.sector);
            const totalSectors = sectorEntries.length;
            const sectorsWithData = sectorEntries.filter(v => (v.captured_count || 0) > 0).length;
            const totalTop = sectorEntries.reduce((s, v) => s + (v.top_count || 0), 0);
            const totalCaptured = sectorEntries.reduce((s, v) => s + (v.captured_count || 0), 0);
            const symbolCoveragePct = totalTop > 0 ? Math.round((totalCaptured / totalTop) * 100) : null;
            const sectorCoveragePct = totalSectors > 0 ? Math.round((sectorsWithData / totalSectors) * 100) : null;
            return new Response(JSON.stringify({
                ok: true,
                run_at: raw.run_at || null,
                coverage: {
                    symbol_coverage_pct: symbolCoveragePct,
                    sector_coverage_pct: sectorCoveragePct,
                    sectors_with_data:   sectorsWithData,
                    total_sectors:       totalSectors,
                    total_captured:      totalCaptured,
                    total_top:           totalTop
                },
                last_run: raw
            }), { headers: withCors({ "Content-Type": "application/json" }) });
        }

        // ── GET /sector/latest ───────────────────────────────────────────────
        // PRD §8 Phase 4 + §14: Read latest sector-taping record for a given
        // sector+symbol from R2 (same-day). Optional staleness guard.
        // Query params: sector (required), symbol (required), date (optional, default today),
        //               stale_max_min (optional, default none)
        if (path === "/sector/latest") {
            const sector = (url.searchParams.get("sector") || "").toUpperCase();
            const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
            if (!sector || !symbol) {
                return new Response(
                    JSON.stringify({ ok: false, error: "Missing required params: sector, symbol" }),
                    { status: 400, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
            const now = new Date();
            const dateParam = url.searchParams.get("date") ||
                `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-${String(now.getUTCDate()).padStart(2,"0")}`;
            const staleMaxMin = clampInt(url.searchParams.get("stale_max_min"), 1, 1440, 0);

            const [yyyy, mm, dd] = dateParam.split("-");
            const key = `sector/${sector}/${symbol}/${yyyy}/${mm}/${dd}.jsonl`;

            try {
                if (!env.FOOTPRINT_BUCKET) throw new Error("FOOTPRINT_BUCKET binding not found");
                const obj = await env.FOOTPRINT_BUCKET.get(key);
                if (!obj) {
                    return new Response(
                        JSON.stringify({ ok: false, error: "No data found", sector, symbol, date: dateParam, key }),
                        { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                    );
                }

                const text = await obj.text();
                const lines = text.trim().split("\n").filter(Boolean);
                // Latest = last line
                const latest = JSON.parse(lines[lines.length - 1]);

                // Staleness guard (PRD §8 Phase 4)
                let staleWarning = null;
                if (staleMaxMin > 0 && latest.ts) {
                    const ageMin = (Date.now() - new Date(latest.ts).getTime()) / 60000;
                    if (ageMin > staleMaxMin) {
                        staleWarning = `data is stale: ${Math.round(ageMin)} min old (limit ${staleMaxMin} min)`;
                    }
                }

                return new Response(JSON.stringify({
                    ok:      !staleWarning,
                    sector,  symbol,  date: dateParam,
                    total_records_today: lines.length,
                    stale_warning: staleWarning || undefined,
                    record: latest
                }), { headers: withCors({ "Content-Type": "application/json" }) });
            } catch (e) {
                return new Response(
                    JSON.stringify({ ok: false, error: e?.message || String(e) }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
        }

        // ── GET /sector/digest ───────────────────────────────────────────
        // Returns freq_tx (sum of levels) + growth_pct (first vs last price)
        // for a single symbol on a given date.
        // Query params: sector (required), symbol (required), date (optional, default today WIB)
        if (path === "/sector/digest") {
            const sector = (url.searchParams.get("sector") || "").toUpperCase();
            const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
            if (!sector || !symbol) {
                return new Response(
                    JSON.stringify({ ok: false, error: "Missing required params: sector, symbol" }),
                    { status: 400, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
            const dateParam = url.searchParams.get("date") || getWibDateString();
            const records   = await readSectorRecords(env, sector, symbol, dateParam);
            if (!records.length) {
                return new Response(
                    JSON.stringify({ ok: false, error: "No data found", sector, symbol, date: dateParam }),
                    { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
            const digest = computeDigest(records);
            return new Response(JSON.stringify({
                ok: true, symbol, sector, date: dateParam, ...digest
            }), { headers: withCors({ "Content-Type": "application/json" }) });
        }

        // ── GET /sector/digest/batch ─────────────────────────────────────────
        // Returns digest for ALL symbols present in the sector aggregate JSONL
        // for a given date. One R2 read for the sector aggregate (to get symbol
        // list), then parallel per-symbol reads in batches of 20.
        // Query params: sector (required), date (optional, default today WIB)
        if (path === "/sector/digest/batch") {
            const sector = (url.searchParams.get("sector") || "").toUpperCase();
            if (!sector) {
                return new Response(
                    JSON.stringify({ ok: false, error: "Missing required param: sector" }),
                    { status: 400, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
            const dateParam  = url.searchParams.get("date") || getWibDateString();
            const [yyyy, mm, dd] = dateParam.split("-");
            const aggKey     = `sector/${sector}/${yyyy}/${mm}/${dd}.jsonl`;

            try {
                const aggObj = await env.FOOTPRINT_BUCKET.get(aggKey);
                if (!aggObj) {
                    return new Response(
                        JSON.stringify({ ok: false, error: "No sector aggregate found", sector, date: dateParam }),
                        { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                    );
                }
                const aggText = await aggObj.text();

                // Collect unique symbols from aggregate
                const symbolSet = new Set();
                for (const line of aggText.split("\n").filter(l => l.trim())) {
                    try {
                        const rec = JSON.parse(line);
                        if (rec.symbol) symbolSet.add(String(rec.symbol).toUpperCase());
                    } catch { /* skip */ }
                }

                if (!symbolSet.size) {
                    return new Response(
                        JSON.stringify({ ok: false, error: "No symbols in sector aggregate", sector, date: dateParam }),
                        { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                    );
                }

                // Parallel reads in batches of 20
                const symbols = [...symbolSet];
                const BATCH   = 20;
                const digests = {};

                for (let i = 0; i < symbols.length; i += BATCH) {
                    const chunk = symbols.slice(i, i + BATCH);
                    await Promise.all(chunk.map(async (sym) => {
                        const records = await readSectorRecords(env, sector, sym, dateParam);
                        if (!records.length) return;
                        const digest  = computeDigest(records);
                        if (digest) digests[sym] = { symbol: sym, sector, date: dateParam, ...digest };
                    }));
                }

                return new Response(JSON.stringify({
                    ok:            true,
                    sector,
                    date:          dateParam,
                    symbols_count: Object.keys(digests).length,
                    digests
                }), { headers: withCors({ "Content-Type": "application/json" }) });
            } catch (e) {
                return new Response(
                    JSON.stringify({ ok: false, error: e?.message || String(e) }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
        }

        // ── GET /sector/cvd/batch ────────────────────────────────────────
        // Returns CVD (from TradedSummary levels) for all symbols across all
        // (or selected) sectors on a given date. Designed for dashboard roster
        // enrichment — one call replaces N per-symbol lookups.
        // Query params: sectors (optional, comma-separated, default all),
        //               date (optional, default today WIB)
        // Response: { ok, date, symbols: { BBCA: { cvd_lot, cvd_delta, freq_tx, growth_pct, sector }, ... } }
        if (path === "/sector/cvd/batch") {
            const sectorsParam = (url.searchParams.get("sectors") || "").trim();
            const sectors = sectorsParam
                ? parseSectorList(sectorsParam)
                : DEFAULT_SECTOR_LIST;
            const dateParam = url.searchParams.get("date") || getWibDateString();
            const [yyyy, mm, dd] = dateParam.split("-");

            try {
                const symbolMap = {}; // symbol → digest + sector

                // Read each sector's aggregate JSONL in parallel
                const sectorReads = sectors.map(async (sector) => {
                    const aggKey = `sector/${sector}/${yyyy}/${mm}/${dd}.jsonl`;
                    const aggObj = await env.FOOTPRINT_BUCKET.get(aggKey);
                    if (!aggObj) return;
                    const aggText = await aggObj.text();

                    // Group records by symbol
                    const bySymbol = new Map();
                    for (const line of aggText.split("\n").filter(l => l.trim())) {
                        try {
                            const rec = JSON.parse(line);
                            const sym = String(rec.symbol || "").toUpperCase();
                            if (!sym) continue;
                            if (!bySymbol.has(sym)) bySymbol.set(sym, []);
                            bySymbol.get(sym).push(rec);
                        } catch { /* skip */ }
                    }

                    for (const [sym, records] of bySymbol) {
                        // Skip if already seen from another sector (keep first)
                        if (symbolMap[sym]) continue;
                        const digest = computeDigest(records);
                        if (digest) {
                            symbolMap[sym] = {
                                sector,
                                cvd_lot:    digest.cvd_lot,
                                cvd_delta:  digest.cvd_delta,
                                freq_tx:    digest.freq_tx,
                                growth_pct: digest.growth_pct,
                                price_last: digest.price_last,
                                price_high: digest.price_high,
                                price_low:  digest.price_low,
                            };
                        }
                    }
                });

                await Promise.all(sectorReads);

                return new Response(JSON.stringify({
                    ok: true,
                    date: dateParam,
                    sectors,
                    symbols_count: Object.keys(symbolMap).length,
                    symbols: symbolMap
                }), { headers: withCors({ "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }) });
            } catch (e) {
                return new Response(
                    JSON.stringify({ ok: false, error: e?.message || String(e) }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
        }

        return new Response(JSON.stringify({ ok: false, error: "Not Found" }),
            { status: 404, headers: withCors({ "Content-Type": "application/json" }) });
    },

    // ── Cron handler ─────────────────────────────────────────────────────────
    async scheduled(event, env, ctx) {
        // ── WIB schedule guard ──────────────────────────────────────────────
        // Cron fires every minute during UTC 01-10 (WIB 08-17), Mon-Fri.
        // Runtime guard enforces the exact windows:
        //   08:30-11:00 WIB  → every 1 minute  (dense: early market)
        //   11:00-12:00 WIB  → every 5 minutes (mid-morning)
        //   12:00-13:00 WIB  → OFF             (lunch break)
        //   13:00-17:00 WIB  → every 5 minutes (afternoon session)
        const _now = new Date();
        const _wib = new Date(_now.getTime() + 7 * 60 * 60 * 1000);
        const _wibMin = _wib.getUTCHours() * 60 + _wib.getUTCMinutes();

        const _START       = 8 * 60 + 30; // 08:30 WIB
        const _DENSE_END   = 11 * 60;     // 11:00 WIB
        const _LUNCH_END   = 13 * 60;     // 13:00 WIB
        const _END         = 17 * 60;     // 17:00 WIB

        // Outside all windows → skip
        if (_wibMin < _START || _wibMin >= _END) {
            console.log(`[sector-scrapper] cron skip (off-hours) wib=${_wib.toISOString()}`);
            return;
        }
        // Lunch break 12:00-13:00 WIB → skip
        if (_wibMin >= 12 * 60 && _wibMin < _LUNCH_END) {
            console.log(`[sector-scrapper] cron skip (lunch break) wib=${_wib.toISOString()}`);
            return;
        }
        // After 11:00 WIB → only run on 5-minute marks
        if (_wibMin >= _DENSE_END && _wib.getUTCMinutes() % 5 !== 0) {
            return; // silent skip for non-5-min slots
        }

        console.log(`[sector-scrapper] cron fired cron=${event.cron} wib=${_wib.toISOString()}`);

        try {
            const sectors     = parseSectorList(env.SECTOR_LIST || "");
            const topN        = clampInt(env.TOP_N_PER_SECTOR,              1, 200, 150);
            const includeLvl  = String(env.SECTOR_TAPE_INCLUDE_LEVELS || "true").toLowerCase() !== "false";
            const levelLimit  = clampInt(env.SECTOR_TAPE_LEVEL_LIMIT,      1, 100, 20);
            const idleMs      = clampInt(env.SECTOR_TAPE_IDLE_MS,          300, 5000, 1200);
            const maxMs       = clampInt(env.SECTOR_TAPE_MAX_MS,           1500, 15000, 7000);
            const levelIdleMs = clampInt(env.SECTOR_TAPE_LEVEL_IDLE_MS,    200, 4000, 700);
            const levelMaxMs  = clampInt(env.SECTOR_TAPE_LEVEL_MAX_MS,     500, 8000, 2200);

            const enqueued = await enqueueSectors(env, sectors, {
                topN, write: true,
                idleMs, maxMs,
                includeLevels: includeLvl, levelLimit, levelIdleMs, levelMaxMs
            });
            console.log(`[sector-scrapper] enqueued ${enqueued} sector messages`);
        } catch (e) {
            console.error(`[sector-scrapper] cron enqueue failed: ${e?.message || e}`);
        }
    },

    // ── Queue consumer ────────────────────────────────────────────────────────
    // Each message carries one sector's job parameters.
    // max_batch_size=3 → up to 3 sectors processed in parallel per invocation.
    async queue(batch, env) {
        const runAt = new Date().toISOString();
        const sectorSummaries = [];

        await Promise.all(batch.messages.map(async (msg) => {
            const {
                sector,
                topN        = 150,
                write       = true,
                idleMs      = 1200,
                maxMs       = 7000,
                includeLevels = true,
                levelLimit  = 20,
                levelIdleMs = 700,
                levelMaxMs  = 2200
            } = msg.body;

            try {
                console.log(`[sector-scrapper:queue] processing sector=${sector} topN=${topN}`);

                const result = await runSectorJob(env, {
                    sector, topN, idleMs, maxMs,
                    includeLevels, levelLimit, levelIdleMs, levelMaxMs
                });

                let writtenKeys = 0;
                if (write) {
                    const w = await writeSectorRecordsToR2(env, result);
                    writtenKeys = w.written_keys;
                }

                const summary = {
                    sector:         result.sector,
                    date:           result.date,
                    top_count:      result.top_count,
                    captured_count: result.captured_count,
                    level_count:    result.level_count,
                    written_keys:   writtenKeys,
                    run_at:         runAt
                };
                sectorSummaries.push(summary);

                console.log(`[sector-scrapper:queue] done sector=${sector} captured=${result.captured_count} keys=${writtenKeys}`);
                msg.ack();
            } catch (e) {
                console.error(`[sector-scrapper:queue] failed sector=${sector}: ${e?.message || e}`);
                // msg.retry() is called implicitly on unhandled rejection,
                // but explicit retry gives us control if needed.
                msg.retry();
            }
        }));

        // Persist run summary to KV (best-effort)
        if (sectorSummaries.length > 0) {
            try {
                const existing = await env.SSSAHAM_WATCHLIST.get("SECTOR_TAPE_LAST_RUN", { type: "json" }) || {};
                const updated  = { ...existing, run_at: runAt };
                for (const s of sectorSummaries) updated[s.sector] = s;
                await env.SSSAHAM_WATCHLIST.put("SECTOR_TAPE_LAST_RUN", JSON.stringify(updated), { expirationTtl: 86400 });
            } catch { }
        }
    }
};
