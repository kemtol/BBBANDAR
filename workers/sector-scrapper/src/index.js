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
 *   GET /backfill/footprint           → backfill footprint for 1 symbol via done_detail (INTERNAL_KEY required)
 *   GET /backfill/footprint/batch     → enqueue backfill for all symbols (INTERNAL_KEY required)
 *   GET /backfill/footprint/status    → read backfill progress from KV (INTERNAL_KEY required)
 *
 * @r2_paths
 *   sector/{SECTOR}/{YYYY}/{MM}/{DD}/latest.jsonl    (per-sector snapshot, overwritten each cycle)
 *   footprint/{TICKER}/1m/{YYYY}/{MM}/{DD}/{HH}.jsonl (backfilled candles)
 *
 * @r2_paths_legacy (read-only fallback, no longer written)
 *   sector/{SECTOR}/{SYMBOL}/{YYYY}/{MM}/{DD}.jsonl  (per-symbol, legacy)
 *   sector/{SECTOR}/{YYYY}/{MM}/{DD}.jsonl           (per-sector aggregate, legacy)
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

/** @deprecated Use writeSectorSnapshotToR2 instead. Kept only for backfill code. */
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

/**
 * Write sector snapshot to R2 as a single JSONL file (write-only, no GET).
 *
 * New path: sector/{SECTOR}/{YYYY}/{MM}/{DD}/latest.jsonl
 * This file is OVERWRITTEN each cron cycle — only contains the latest snapshot.
 * Open prices are cached in KV for growth_pct / cvd_delta computation.
 *
 * R2 ops: 1 PUT per sector per cycle (was: ~302 GET+PUT per sector per cycle).
 *
 * @param {object} env           — Cloudflare env bindings
 * @param {object} sectorResult  — output from runSectorJob()
 * @returns {{ written_keys: number, written_records: number }}
 */
async function writeSectorSnapshotToR2(env, sectorResult) {
    if (!env.FOOTPRINT_BUCKET) throw new Error("FOOTPRINT_BUCKET binding not found");
    const { sector, yyyy, mm, dd, records } = sectorResult;
    const dateStr = `${yyyy}-${mm}-${dd}`;

    // Dedup within this result — key: symbol + 1-minute ts bucket
    const dedup = new Map();
    for (const r of records) {
        const tsBucket = r.ts ? r.ts.slice(0, 16) : "";
        dedup.set(`${r.symbol}|${tsBucket}`, r);
    }
    const finalRecords = Array.from(dedup.values());
    if (finalRecords.length === 0) return { written_keys: 0, written_records: 0 };

    // ── Read open prices from KV (cached from first cycle of the day) ────
    const kvOpenKey = `SECTOR_OPEN:${sector}:${dateStr}`;
    let openMap = null; // symbol → { price_last, cvd_lot }
    try {
        openMap = await env.SSSAHAM_WATCHLIST.get(kvOpenKey, { type: "json" });
    } catch { }

    // ── If no open data yet, this is the first cycle → save open prices ──
    if (!openMap) {
        openMap = {};
        for (const rec of finalRecords) {
            const sym = String(rec.symbol || "").toUpperCase();
            if (!sym) continue;
            openMap[sym] = {
                price_last: rec.price_last ?? null,
                cvd_lot:    rec.cvd_lot ?? null
            };
        }
        try {
            await env.SSSAHAM_WATCHLIST.put(kvOpenKey, JSON.stringify(openMap), { expirationTtl: 86400 });
        } catch { }
    }

    // ── Enrich records with pre-computed digest fields ────────────────────
    for (const rec of finalRecords) {
        const sym = String(rec.symbol || "").toUpperCase();
        const open = openMap[sym];

        // price_open: from first cycle of the day
        rec.price_open = open?.price_last ?? rec.price_last;

        // growth_pct: (current - open) / open × 100
        if (rec.price_open != null && rec.price_last != null && rec.price_open !== 0) {
            rec.growth_pct = parseFloat(
                (((rec.price_last - rec.price_open) / rec.price_open) * 100).toFixed(4)
            );
        } else {
            rec.growth_pct = null;
        }

        // cvd_delta: change from first cycle
        const cvdOpen = open?.cvd_lot ?? null;
        if (rec.cvd_lot != null && cvdOpen != null) {
            rec.cvd_delta = rec.cvd_lot - cvdOpen;
        } else {
            rec.cvd_delta = null;
        }
    }

    // ── Write single JSONL file (write-only, no GET) ─────────────────────
    const snapshotKey = `sector/${sector}/${yyyy}/${mm}/${dd}/latest.jsonl`;
    const body = finalRecords.map(r => JSON.stringify(r)).join("\n") + "\n";
    await env.FOOTPRINT_BUCKET.put(snapshotKey, body, {
        httpMetadata: { contentType: "application/x-ndjson" }
    });

    return { written_keys: 1, written_records: finalRecords.length };
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
 * Read sector snapshot JSONL from R2.
 * New path: sector/{SECTOR}/{YYYY}/{MM}/{DD}/latest.jsonl
 * Fallback: sector/{SECTOR}/{YYYY}/{MM}/{DD}.jsonl (legacy aggregate)
 *
 * @param {object} env
 * @param {string} sector  — e.g. "IDXFINANCE"
 * @param {string} date    — "YYYY-MM-DD"
 * @returns {object[]}     — array of parsed JSONL records
 */
async function readSectorSnapshot(env, sector, date) {
    const [yyyy, mm, dd] = date.split("-");
    const newKey    = `sector/${sector}/${yyyy}/${mm}/${dd}/latest.jsonl`;
    const legacyKey = `sector/${sector}/${yyyy}/${mm}/${dd}.jsonl`;

    for (const key of [newKey, legacyKey]) {
        try {
            const obj = await env.FOOTPRINT_BUCKET.get(key);
            if (!obj) continue;
            const text = await obj.text();
            const records = [];
            for (const line of text.split("\n")) {
                if (!line.trim()) continue;
                try { records.push(JSON.parse(line)); } catch { /* skip */ }
            }
            if (records.length > 0) return records;
        } catch { /* try next key */ }
    }
    return [];
}

/**
 * @deprecated Legacy per-symbol reader. Use readSectorSnapshot + filter instead.
 */
async function readSectorRecords(env, sector, symbol, date) {
    // Try new snapshot path first (filter by symbol)
    const allRecords = await readSectorSnapshot(env, sector, date);
    if (allRecords.length > 0) {
        const symUpper = symbol.toUpperCase();
        return allRecords.filter(r => String(r.symbol || "").toUpperCase() === symUpper);
    }
    // Fallback: legacy per-symbol path
    const [yyyy, mm, dd] = date.split("-");
    const key = `sector/${sector}/${symbol}/${yyyy}/${mm}/${dd}.jsonl`;
    try {
        const obj = await env.FOOTPRINT_BUCKET.get(key);
        if (!obj) return [];
        const text  = await obj.text();
        const records = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line)); } catch { /* skip */ }
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
// Footprint Backfill via xen_qu_done_detail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse one row of xen_qu_done_detail:
 *   TRADE_ID|SYMBOL|BOARD|HH:MM:SS|PRICE|LOT|...|...|...|...|CUM_VAL|FLAG|CUM_VOL
 *   e.g. "10568352179|TLKM|RG|15:02:47|3210.00|2800|--|-|--|-|1591290|0|4354484"
 */
function parseDoneDetailLine(raw) {
    if (!raw || typeof raw !== "string") return null;
    const t = raw.split("|").map(x => String(x || "").trim());
    if (t.length < 6) return null;

    const tradeId = t[0];
    const symbol  = t[1].toUpperCase();
    const board   = t[2].toUpperCase();
    const timeStr = t[3];               // "HH:MM:SS" WIB
    const price   = parseFloat(t[4]);
    const lot     = parseInt(t[5], 10);

    if (!symbol || board !== "RG") return null;
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(lot)   || lot   <= 0) return null;
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(timeStr)) return null;

    return { tradeId, symbol, board, timeStr, price, lot };
}

/**
 * Fetch pages of done_detail for a symbol from iPOT WS.
 * Returns array of parsed trade records sorted ascending by time.
 *
 * Continuation across WS sessions uses `afterTradeId`:
 * - Each WS session creates a new slid; pageno resets per session.
 * - To continue, we start from page 1 but skip (fast-forward) all records
 *   with tradeId <= afterTradeId, then collect maxPages worth of NEW data.
 *
 * @param {object} env
 * @param {string} symbol    e.g. "TLKM"
 * @param {string} board     e.g. "RG"
 * @param {object} opts      { pageLen=100, maxPages=50, maxMs=40000, afterTradeId=null }
 * @returns {{ trades: object[], pages_fetched: number, total_records: number, last_trade_id: string|null, exhausted: boolean }}
 */
async function fetchAllDoneDetail(env, symbol, board = "RG", opts = {}) {
    const pageLen      = opts.pageLen      || 5000;   // 5K records per page (API supports it)
    const maxNewPages  = opts.maxPages     || 10;     // collect up to 10 pages of NEW data = 50K records
    const maxMs        = opts.maxMs        || 40000;  // 40s total budget per chunk
    const afterTradeId = opts.afterTradeId || null;   // skip trades with id <= this

    let ws;
    try {
        ws = await openIpotWs(env);
    } catch {
        await clearIpotAppSession(env);
        ws = await openIpotWs(env);
    }

    const allTrades = [];
    const seenIds   = new Set();
    let cid   = 200;
    let cmdid = 200;
    let pagesFetched    = 0;
    let newPagesCollected = 0;  // pages that actually contributed new records
    let slid = null;
    let lastTradeId = afterTradeId;
    let exhausted = false;
    let skippedPages = 0;
    const globalStart = Date.now();

    try {
        for (let pageNo = 1; ; pageNo++) {
            // Stop if we've collected enough new pages
            if (newPagesCollected >= maxNewPages) break;
            if (Date.now() - globalStart > maxMs) {
                console.log(`[backfill] ${symbol} hit time limit at page ${pageNo} (skipped=${skippedPages}, new=${newPagesCollected})`);
                break;
            }

            const queryCmdid = ++cmdid;
            const queryCid   = ++cid;

            const records = [];
            let gotRes  = false;
            let lastAt  = Date.now();
            const pageStart = Date.now();

            const onMsg = (ev) => {
                lastAt = Date.now();
                const txt = typeof ev.data === "string" ? ev.data : "";
                if (txt === "#1") { try { ws.send("#2"); } catch { } return; }
                let j; try { j = JSON.parse(txt); } catch { return; }

                const msgCmdid = Number(j?.data?.cmdid);
                if (j?.event === "record" && msgCmdid === queryCmdid) {
                    const recno = j?.data?.recno;
                    if (recno === -1) {
                        gotRes = true;
                        return;
                    }
                    const d = j?.data?.data || {};
                    if (!slid && d.slid) slid = d.slid;
                    const raw = d.rec || d.xen_qu_done_detail || null;
                    if (typeof raw === "string" && raw.includes("|")) {
                        records.push(raw);
                    }
                }
                if (j?.event === "res" && msgCmdid === queryCmdid) {
                    gotRes = true;
                }
            };

            ws.addEventListener("message", onMsg);

            const queryInnerParam = {
                source:  "datafeed",
                index:   "xen_qu_done_detail",
                args:    [symbol, board],
                info:    { pageno: pageNo, orderby: [[0, "ASC"]] },
                pagelen: pageLen
            };
            if (slid) queryInnerParam.slid = slid;

            ws.send(JSON.stringify({
                event: "cmd",
                data: {
                    cmdid: queryCmdid,
                    param: {
                        service: "midata",
                        cmd:     "query",
                        param:   queryInnerParam
                    }
                },
                cid: queryCid
            }));

            const pageMaxMs = 20000;  // 20s per page budget (large pages)
            while (true) {
                const nowMs = Date.now();
                if (nowMs - pageStart > pageMaxMs) break;
                if (gotRes) break;
                if (!gotRes && records.length === 0 && (nowMs - lastAt) > 5000) break;
                await new Promise(r => setTimeout(r, 30));
            }
            ws.removeEventListener("message", onMsg);

            pagesFetched++;

            // Parse records and filter by afterTradeId
            let newCount = 0;
            let allSkipped = true;  // true if every record on this page was skipped
            for (const raw of records) {
                const parsed = parseDoneDetailLine(raw);
                if (!parsed) continue;
                // Skip records we already processed in previous chunks
                if (afterTradeId && parsed.tradeId <= afterTradeId) continue;
                allSkipped = false;
                if (seenIds.has(parsed.tradeId)) continue;
                seenIds.add(parsed.tradeId);
                allTrades.push(parsed);
                if (parsed.tradeId > (lastTradeId || "")) lastTradeId = parsed.tradeId;
                newCount++;
            }

            if (allSkipped && records.length > 0) {
                // Entire page was already processed → fast-forward
                skippedPages++;
                // Log every 20 skipped pages to avoid spam
                if (skippedPages % 20 === 0) {
                    console.log(`[backfill] ${symbol} fast-forwarding... skipped ${skippedPages} pages so far`);
                }
                continue;  // don't count toward newPagesCollected
            }

            if (newCount > 0) {
                newPagesCollected++;
            }

            if (newPagesCollected % 10 === 0 || records.length < pageLen) {
                console.log(`[backfill] ${symbol} page ${pageNo}: ${records.length} raw, ${newCount} new, total=${allTrades.length} (skipped=${skippedPages})`);
            }

            // Last page reached
            if (records.length < pageLen) {
                console.log(`[backfill] ${symbol} last page reached (got ${records.length} < ${pageLen})`);
                exhausted = true;
                break;
            }

            // Empty page
            if (records.length === 0) {
                console.log(`[backfill] ${symbol} empty page at ${pageNo}, stopping`);
                exhausted = true;
                break;
            }
        }
    } finally {
        try { ws.close(); } catch { }
    }

    // Sort ascending by time
    allTrades.sort((a, b) => a.timeStr.localeCompare(b.timeStr));

    console.log(`[backfill] ${symbol} FETCH done: ${allTrades.length} trades, ${pagesFetched} pages fetched, ${skippedPages} skipped, exhausted=${exhausted}`);

    return {
        trades: allTrades,
        pages_fetched: pagesFetched,
        total_records: allTrades.length,
        last_trade_id: lastTradeId,
        exhausted
    };
}

/**
 * Convert sorted trade array → 1-minute footprint candles.
 * Uses uptick rule (identical to livetrade-durable-object StateEngine.updateFootprint).
 *
 * @param {object[]} trades     — sorted ascending by timeStr
 * @param {string}   dateStr    — "YYYY-MM-DD"
 * @returns {object[]}          — array of candle objects { t0, ohlc, vol, delta, levels }
 */
function buildFootprintCandles(trades, dateStr) {
    if (!trades || trades.length === 0) return [];

    const [yyyy, mm, dd] = dateStr.split("-").map(Number);
    const candleMap = new Map(); // minuteKey (epoch ms) → candle
    let _lastPriceByMinute = new Map(); // minuteKey → last price for uptick rule

    for (const trade of trades) {
        // Parse WIB time → UTC epoch
        const [hh, mi, ss] = trade.timeStr.split(":").map(Number);
        // Build WIB Date → convert to UTC
        const wibDate = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
        const utcMs   = wibDate.getTime() - 7 * 60 * 60 * 1000; // WIB-7 = UTC

        // Floor to minute
        const minuteMs = utcMs - (utcMs % 60000);
        const minuteKey = minuteMs;

        let candle = candleMap.get(minuteKey);
        if (!candle) {
            candle = {
                t0: minuteKey,
                ohlc: { o: trade.price, h: trade.price, l: trade.price, c: trade.price },
                vol: 0,
                delta: 0,
                levels: [],        // [{p, bv, av}]
                _lastPrice: null   // internal, stripped before write
            };
            candleMap.set(minuteKey, candle);
        }

        // Update OHLC
        candle.ohlc.h = Math.max(candle.ohlc.h, trade.price);
        candle.ohlc.l = Math.min(candle.ohlc.l, trade.price);
        candle.ohlc.c = trade.price;
        candle.vol += trade.lot;

        // Uptick rule for delta (identical to StateEngine)
        if (candle._lastPrice == null) candle._lastPrice = trade.price;
        let side = "neutral";
        if (trade.price > candle._lastPrice) side = "buy";
        else if (trade.price < candle._lastPrice) side = "sell";
        candle._lastPrice = trade.price;

        if (side === "buy")  candle.delta += trade.lot;
        if (side === "sell") candle.delta -= trade.lot;

        // Levels (price-level footprint)
        let level = candle.levels.find(l => l.p === trade.price);
        if (!level) {
            level = { p: trade.price, bv: 0, av: 0 };
            candle.levels.push(level);
        }
        if (side === "buy")  level.bv += trade.lot;
        if (side === "sell") level.av += trade.lot;
    }

    // Sort candles ascending by t0, strip internal fields
    const candles = Array.from(candleMap.values())
        .sort((a, b) => a.t0 - b.t0)
        .map(c => ({
            t0:    c.t0,
            ohlc:  c.ohlc,
            vol:   c.vol,
            delta: c.delta,
            levels: c.levels
        }));

    return candles;
}

/**
 * Write footprint candles to R2 in the same format as livetrade-durable-object.
 * Path: footprint/{TICKER}/1m/{YYYY}/{MM}/{DD}/{HH}.jsonl
 * Groups candles by UTC hour, writes each hour file.
 *
 * @param {object}   env
 * @param {string}   ticker
 * @param {string}   dateStr  — "YYYY-MM-DD"
 * @param {object[]} candles  — sorted array of candle objects
 * @param {boolean}  merge    — if true, merge with existing R2 data (default true)
 * @returns {{ hours_written, candles_written }}
 */
async function writeFootprintCandlesToR2(env, ticker, dateStr, candles, merge = true) {
    if (!env.FOOTPRINT_BUCKET) throw new Error("FOOTPRINT_BUCKET binding not found");
    if (!candles || candles.length === 0) return { hours_written: 0, candles_written: 0 };

    const [yyyy, mm, dd] = dateStr.split("-");
    const sym = ticker.toUpperCase();

    // Group candles by UTC hour
    const byHour = new Map();
    for (const c of candles) {
        const dt = new Date(c.t0);
        const hh = String(dt.getUTCHours()).padStart(2, "0");
        if (!byHour.has(hh)) byHour.set(hh, []);
        byHour.get(hh).push(c);
    }

    let hoursWritten   = 0;
    let candlesWritten = 0;

    for (const [hh, hourCandles] of byHour.entries()) {
        const r2Key = `footprint/${sym}/1m/${yyyy}/${mm}/${dd}/${hh}.jsonl`;

        // Merge with existing if requested
        let finalCandles = hourCandles;
        if (merge) {
            try {
                const existing = await env.FOOTPRINT_BUCKET.get(r2Key);
                if (existing) {
                    const text = await existing.text();
                    const existingCandles = text.split("\n")
                        .filter(l => l.trim())
                        .map(l => { try { return JSON.parse(l); } catch { return null; } })
                        .filter(Boolean);

                    // Merge: backfill candles fill gaps, existing candles take precedence
                    const mergedMap = new Map();
                    for (const c of hourCandles) mergedMap.set(c.t0, c);     // backfill first
                    for (const c of existingCandles) mergedMap.set(c.t0, c); // existing overwrites
                    finalCandles = Array.from(mergedMap.values()).sort((a, b) => a.t0 - b.t0);
                }
            } catch { /* if read fails, just write backfill data */ }
        }

        // Write as JSONL
        const body = finalCandles.map(c => JSON.stringify(c)).join("\n") + "\n";
        await env.FOOTPRINT_BUCKET.put(r2Key, body, {
            httpMetadata: { contentType: "application/x-ndjson" }
        });

        hoursWritten++;
        candlesWritten += finalCandles.length;
    }

    return { hours_written: hoursWritten, candles_written: candlesWritten };
}

/**
 * Full backfill pipeline for one symbol (one chunk):
 * 1. Fetch done_detail trades via WS (skip trades with id <= afterTradeId)
 * 2. Build 1-minute candles with uptick rule
 * 3. Write to R2 (merge with existing)
 * 4. If not exhausted, enqueue continuation message with last_trade_id
 *
 * @param {object} env
 * @param {string} symbol     e.g. "AADI"
 * @param {string} dateStr    e.g. "2026-03-06"
 * @param {object} opts       { board, pageLen, maxPages, maxMs, merge, afterTradeId }
 * @returns {object}          summary
 */
async function runFootprintBackfill(env, symbol, dateStr, opts = {}) {
    const board        = opts.board        || "RG";
    const merge        = opts.merge !== false;
    const afterTradeId = opts.afterTradeId || null;

    console.log(`[backfill:footprint] START ${symbol} date=${dateStr} afterTradeId=${afterTradeId || "none"}`);
    const t0 = Date.now();

    // Step 1: Fetch trades (one chunk, fast-forwarding past afterTradeId)
    const { trades, pages_fetched, total_records, last_trade_id, exhausted } =
        await fetchAllDoneDetail(env, symbol, board, {
            pageLen:      opts.pageLen  || 5000,
            maxPages:     opts.maxPages || 10,
            maxMs:        opts.maxMs    || 40000,
            afterTradeId
        });

    if (trades.length === 0) {
        console.log(`[backfill:footprint] ${symbol} no trades found (afterTradeId=${afterTradeId || "none"})`);
        return {
            ok: true,
            symbol, date: dateStr,
            trades: 0, candles: 0, hours_written: 0,
            pages_fetched, last_trade_id, exhausted,
            elapsed_ms: Date.now() - t0,
            status: exhausted ? "NO_TRADES" : "CHUNK_EMPTY"
        };
    }

    // Step 2: Build candles
    const candles = buildFootprintCandles(trades, dateStr);

    // Step 3: Write to R2
    const { hours_written, candles_written } = await writeFootprintCandlesToR2(
        env, symbol, dateStr, candles, merge
    );

    // Step 4: If not exhausted and queue is available, enqueue continuation
    let continued = false;
    if (!exhausted && env.SECTOR_TAPE_QUEUE) {
        try {
            await env.SECTOR_TAPE_QUEUE.send({
                type: "backfill_footprint",
                symbol,
                date: dateStr,
                board,
                merge: true,
                afterTradeId: last_trade_id
            });
            continued = true;
            console.log(`[backfill:footprint] ${symbol} continuation enqueued afterTradeId=${last_trade_id}`);
        } catch (e) {
            console.error(`[backfill:footprint] ${symbol} continuation enqueue failed: ${e?.message}`);
        }
    }

    const elapsed = Date.now() - t0;
    console.log(`[backfill:footprint] DONE ${symbol} chunk afterTradeId=${afterTradeId || "none"} trades=${total_records} candles=${candles.length} hours=${hours_written} elapsed=${elapsed}ms exhausted=${exhausted}`);

    return {
        ok: true,
        symbol,
        date: dateStr,
        trades: total_records,
        pages_fetched,
        last_trade_id,
        exhausted,
        continued,
        candles: candles.length,
        candles_written,
        hours_written,
        elapsed_ms: elapsed,
        time_range: trades.length > 0
            ? { first: trades[0].timeStr, last: trades[trades.length - 1].timeStr }
            : null,
        status: exhausted ? "BACKFILLED" : "CHUNK_DONE"
    };
}

/**
 * Collect all unique symbols from today's sector aggregate JSONLs in R2.
 * @param {object} env
 * @param {string} dateStr  — "YYYY-MM-DD"
 * @returns {string[]}      — sorted unique symbol list
 */
async function collectSymbolsFromSectorData(env, dateStr) {
    const symbolSet = new Set();

    await Promise.all(DEFAULT_SECTOR_LIST.map(async (sector) => {
        try {
            const records = await readSectorSnapshot(env, sector, dateStr);
            for (const rec of records) {
                if (rec.symbol) symbolSet.add(String(rec.symbol).toUpperCase());
            }
        } catch { }
    }));

    return Array.from(symbolSet).sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable Object: FootprintBackfillDO
// ─────────────────────────────────────────────────────────────────────────────
//
// Each instance handles ONE symbol's full-day backfill.
// - Opens a single iPOT WS session (no pagination cursor issues)
// - Fetches ALL pages of done_detail in one session
// - Accumulates trades in memory
// - Builds candles & writes to R2 only when ALL data is collected
//
// ID naming:  `BACKFILL:{SYMBOL}:{DATE}`  e.g. "BACKFILL:BBRI:2026-03-06"
// ─────────────────────────────────────────────────────────────────────────────

export class FootprintBackfillDO {
    constructor(state, env) {
        this.state = state;
        this.env   = env;
    }

    async fetch(request) {
        const url    = new URL(request.url);
        const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
        const dateStr = url.searchParams.get("date") || getWibDateString();
        const board  = (url.searchParams.get("board") || "RG").toUpperCase();
        const merge  = url.searchParams.get("merge") !== "false";
        const pageLen = parseInt(url.searchParams.get("pagelen") || "5000", 10);

        if (!symbol) {
            return new Response(JSON.stringify({ ok: false, error: "Missing symbol" }), {
                status: 400, headers: { "Content-Type": "application/json" }
            });
        }

        console.log(`[BackfillDO] START ${symbol} date=${dateStr} board=${board} pageLen=${pageLen}`);
        const t0 = Date.now();

        try {
            // ── Step 1: Open WS, fetch ALL pages in one session ─────────────
            const { trades, pages_fetched, exhausted } =
                await this._fetchAllTrades(symbol, board, pageLen);

            if (trades.length === 0) {
                const result = {
                    ok: true, symbol, date: dateStr,
                    trades: 0, candles: 0, hours_written: 0,
                    pages_fetched, exhausted,
                    elapsed_ms: Date.now() - t0,
                    status: "NO_TRADES"
                };
                console.log(`[BackfillDO] ${symbol} NO_TRADES`);
                return Response.json(result);
            }

            // ── Step 2: Build candles ───────────────────────────────────────
            const candles = buildFootprintCandles(trades, dateStr);

            // ── Step 3: Write to R2 (merge with existing) ───────────────────
            const { hours_written, candles_written } =
                await writeFootprintCandlesToR2(this.env, symbol, dateStr, candles, merge);

            const elapsed = Date.now() - t0;
            const timeRange = trades.length > 0
                ? { first: trades[0].timeStr, last: trades[trades.length - 1].timeStr }
                : null;

            const result = {
                ok: true, symbol, date: dateStr,
                trades: trades.length,
                pages_fetched,
                exhausted,
                candles: candles.length,
                candles_written,
                hours_written,
                elapsed_ms: elapsed,
                time_range: timeRange,
                status: "BACKFILLED"
            };

            console.log(`[BackfillDO] DONE ${symbol} trades=${trades.length} candles=${candles.length} hours=${hours_written} elapsed=${elapsed}ms`);
            return Response.json(result);
        } catch (e) {
            const elapsed = Date.now() - t0;
            console.error(`[BackfillDO] FAIL ${symbol}: ${e?.message || e}`);
            return Response.json({
                ok: false, symbol, date: dateStr,
                error: e?.message || String(e),
                elapsed_ms: elapsed,
                status: "ERROR"
            }, { status: 500 });
        }
    }

    /**
     * Fetch ALL done_detail pages in a single WS session.
     * No chunk limit — relies on DO's generous wall-clock time.
     * CPU time is minimal (just parsing JSON), I/O wait doesn't count.
     */
    async _fetchAllTrades(symbol, board, pageLen = 5000) {
        let ws;
        try {
            ws = await openIpotWs(this.env);
        } catch {
            await clearIpotAppSession(this.env);
            ws = await openIpotWs(this.env);
        }

        const allTrades = [];
        const seenIds   = new Set();
        let cid   = 200;
        let cmdid = 200;
        let pagesFetched = 0;
        let slid = null;
        let exhausted = false;

        // Keep WS alive with periodic pings (iPOT has 60s pingTimeout)
        const keepAlive = setInterval(() => {
            try { ws.send("#2"); } catch { }
        }, 20000);

        try {
            for (let pageNo = 1; ; pageNo++) {
                const queryCmdid = ++cmdid;
                const queryCid   = ++cid;

                const records = [];
                let gotFooter = false;
                let lastAt    = Date.now();
                const pageStart = Date.now();

                const onMsg = (ev) => {
                    lastAt = Date.now();
                    const txt = typeof ev.data === "string" ? ev.data : "";
                    if (txt === "#1") { try { ws.send("#2"); } catch { } return; }
                    let j; try { j = JSON.parse(txt); } catch { return; }

                    const msgCmdid = Number(j?.data?.cmdid);
                    if (j?.event === "record" && msgCmdid === queryCmdid) {
                        const recno = j?.data?.recno;
                        if (recno === -1) { gotFooter = true; return; }
                        const d = j?.data?.data || {};
                        if (!slid && d.slid) slid = d.slid;
                        const raw = d.rec || d.xen_qu_done_detail || null;
                        if (typeof raw === "string" && raw.includes("|")) {
                            records.push(raw);
                        }
                    }
                    if (j?.event === "res" && msgCmdid === queryCmdid) {
                        gotFooter = true;
                    }
                };

                ws.addEventListener("message", onMsg);

                // Build query
                const queryInnerParam = {
                    source:  "datafeed",
                    index:   "xen_qu_done_detail",
                    args:    [symbol, board],
                    info:    { pageno: pageNo, orderby: [[0, "ASC"]] },
                    pagelen: pageLen
                };
                if (slid) queryInnerParam.slid = slid;

                ws.send(JSON.stringify({
                    event: "cmd",
                    data: {
                        cmdid: queryCmdid,
                        param: {
                            service: "midata",
                            cmd:     "query",
                            param:   queryInnerParam
                        }
                    },
                    cid: queryCid
                }));

                // Wait for page — 30s per page budget (large pages take time)
                const pageMaxMs = 30000;
                while (true) {
                    const now = Date.now();
                    if (now - pageStart > pageMaxMs) break;
                    if (gotFooter) break;
                    if (!gotFooter && records.length === 0 && (now - lastAt) > 8000) break;
                    await new Promise(r => setTimeout(r, 30));
                }
                ws.removeEventListener("message", onMsg);

                pagesFetched++;

                // Parse & dedup
                let newCount = 0;
                for (const raw of records) {
                    const parsed = parseDoneDetailLine(raw);
                    if (!parsed) continue;
                    if (seenIds.has(parsed.tradeId)) continue;
                    seenIds.add(parsed.tradeId);
                    allTrades.push(parsed);
                    newCount++;
                }

                // Progress log every 5 pages
                if (pageNo % 5 === 0 || records.length < pageLen) {
                    console.log(`[BackfillDO] ${symbol} page ${pageNo}: ${records.length} raw, ${newCount} new, total=${allTrades.length}`);
                }

                // End conditions
                if (records.length < pageLen) {
                    exhausted = true;
                    console.log(`[BackfillDO] ${symbol} last page (got ${records.length} < ${pageLen})`);
                    break;
                }
                if (records.length === 0) {
                    exhausted = true;
                    break;
                }
            }
        } finally {
            clearInterval(keepAlive);
            try { ws.close(); } catch { }
        }

        // Sort ascending by time
        allTrades.sort((a, b) => a.timeStr.localeCompare(b.timeStr));

        console.log(`[BackfillDO] ${symbol} TOTAL: ${allTrades.length} trades, ${pagesFetched} pages, exhausted=${exhausted}`);
        return { trades: allTrades, pages_fetched: pagesFetched, exhausted };
    }
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
                        const w = await writeSectorSnapshotToR2(env, result);
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

            try {
                if (!env.FOOTPRINT_BUCKET) throw new Error("FOOTPRINT_BUCKET binding not found");
                const records = await readSectorRecords(env, sector, symbol, dateParam);
                if (!records.length) {
                    return new Response(
                        JSON.stringify({ ok: false, error: "No data found", sector, symbol, date: dateParam }),
                        { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                    );
                }

                // Latest = last record (already sorted or latest snapshot)
                const latest = records[records.length - 1];

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
                    total_records_today: records.length,
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
        // Returns digest for ALL symbols in a sector snapshot.
        // Single R2 read — records already contain pre-computed digest fields
        // (growth_pct, cvd_delta, price_open) from writeSectorSnapshotToR2.
        // Query params: sector (required), date (optional, default today WIB)
        if (path === "/sector/digest/batch") {
            const sector = (url.searchParams.get("sector") || "").toUpperCase();
            if (!sector) {
                return new Response(
                    JSON.stringify({ ok: false, error: "Missing required param: sector" }),
                    { status: 400, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
            const dateParam = url.searchParams.get("date") || getWibDateString();

            try {
                const records = await readSectorSnapshot(env, sector, dateParam);
                if (!records.length) {
                    return new Response(
                        JSON.stringify({ ok: false, error: "No sector snapshot found", sector, date: dateParam }),
                        { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                    );
                }

                // Build digest per symbol from snapshot records.
                // Snapshot records already have pre-computed fields (growth_pct, cvd_delta, price_open)
                // so we can return them directly without re-computing from full history.
                const digests = {};
                for (const rec of records) {
                    const sym = String(rec.symbol || "").toUpperCase();
                    if (!sym || digests[sym]) continue;

                    // Use pre-computed fields from snapshot; fall back to computeDigest for legacy data
                    const freq_tx = (Array.isArray(rec.levels) && rec.levels.length > 0)
                        ? rec.levels.reduce((sum, lv) => sum + (Number(lv.b_freq) || 0) + (Number(lv.s_freq) || 0), 0)
                        : (rec.freq_tx ?? null);

                    digests[sym] = {
                        symbol:       sym,
                        sector,
                        date:         dateParam,
                        freq_tx,
                        freq_source:  (Array.isArray(rec.levels) && rec.levels.length > 0) ? "levels_sum" : "snapshot_field",
                        price_open:   rec.price_open ?? rec.price_last,
                        price_last:   rec.price_last ?? null,
                        price_high:   rec.price_high ?? null,
                        price_low:    rec.price_low ?? null,
                        growth_pct:   rec.growth_pct ?? null,
                        cvd_lot:      rec.cvd_lot ?? null,
                        cvd_delta:    rec.cvd_delta ?? null,
                        snapshots_count: 1,
                        ts_first:     rec.ts,
                        ts_last:      rec.ts,
                    };
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

            try {
                const symbolMap = {}; // symbol → digest + sector

                // Read each sector's snapshot JSONL in parallel
                await Promise.all(sectors.map(async (sector) => {
                    const records = await readSectorSnapshot(env, sector, dateParam);
                    for (const rec of records) {
                        const sym = String(rec.symbol || "").toUpperCase();
                        if (!sym || symbolMap[sym]) continue; // first sector wins
                        symbolMap[sym] = {
                            sector,
                            cvd_lot:    rec.cvd_lot ?? null,
                            cvd_delta:  rec.cvd_delta ?? null,
                            freq_tx:    rec.freq_tx ?? null,
                            growth_pct: rec.growth_pct ?? null,
                            price_last: rec.price_last ?? null,
                            price_high: rec.price_high ?? null,
                            price_low:  rec.price_low ?? null,
                        };
                    }
                }));

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

        // ── GET /backfill/footprint ──────────────────────────────────────────
        // Backfill footprint for a single symbol using xen_qu_done_detail.
        // Routes to one of 7 engine workers via round-robin service bindings.
        // Query params: symbol (required), date (optional, default today WIB),
        //               board (optional, default RG), merge (optional, default true),
        //               engine (optional, 1-7, override round-robin)
        if (path === "/backfill/footprint") {
            const symbol = (url.searchParams.get("symbol") || url.searchParams.get("kode") || "").toUpperCase();
            if (!symbol) {
                return new Response(
                    JSON.stringify({ ok: false, error: "Missing required param: symbol" }),
                    { status: 400, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
            const dateParam = url.searchParams.get("date") || getWibDateString();
            const board     = (url.searchParams.get("board") || "RG").toUpperCase();
            const merge     = url.searchParams.get("merge") !== "false";
            const engineOverride = parseInt(url.searchParams.get("engine") || "0", 10);

            try {
                // Pick engine: explicit override or hash-based round-robin
                const engines = [env.ENGINE_1, env.ENGINE_2, env.ENGINE_3, env.ENGINE_4, env.ENGINE_5, env.ENGINE_6, env.ENGINE_7];
                let engineIdx;
                if (engineOverride >= 1 && engineOverride <= 7) {
                    engineIdx = engineOverride - 1;
                } else {
                    // Hash symbol name for deterministic routing (same symbol always goes to same engine)
                    let hash = 0;
                    for (let i = 0; i < symbol.length; i++) hash = ((hash << 5) - hash + symbol.charCodeAt(i)) | 0;
                    engineIdx = Math.abs(hash) % 7;
                }
                const engine = engines[engineIdx];

                const engineUrl = new URL("https://engine/backfill");
                engineUrl.searchParams.set("symbol", symbol);
                engineUrl.searchParams.set("date", dateParam);
                engineUrl.searchParams.set("board", board);
                engineUrl.searchParams.set("merge", String(merge));

                console.log(`[backfill] ${symbol} → engine-${engineIdx + 1}`);
                const resp = await engine.fetch(engineUrl.toString());
                const result = await resp.json();
                result._engine = engineIdx + 1;
                return new Response(JSON.stringify(result), {
                    status: resp.status,
                    headers: withCors({ "Content-Type": "application/json" })
                });
            } catch (e) {
                return new Response(
                    JSON.stringify({ ok: false, error: e?.message || String(e), symbol, date: dateParam }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
        }

        // ── GET /backfill/footprint/batch ────────────────────────────────────
        // Round-robin backfill across 7 engine workers.
        // Each engine hosts its own BackfillEngine DO, so we get 7× parallelism.
        // Uses ctx.waitUntil to process in background, returns 202 immediately.
        // Query params: date (optional), max (optional), offset (optional), symbols (optional)
        // concurrency (optional, default 7): how many parallel requests (max = 7 engines × N)
        if (path === "/backfill/footprint/batch") {
            const dateParam    = url.searchParams.get("date") || getWibDateString();
            const maxSymbols   = clampInt(url.searchParams.get("max"), 1, 2000, 2000);
            const offset       = clampInt(url.searchParams.get("offset"), 0, 5000, 0);
            const concurrency  = clampInt(url.searchParams.get("concurrency"), 1, 21, 7);
            const symbolsParam = (url.searchParams.get("symbols") || "").trim();

            try {
                let symbols;
                if (symbolsParam) {
                    symbols = symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
                } else {
                    symbols = await collectSymbolsFromSectorData(env, dateParam);
                }

                if (symbols.length === 0) {
                    return new Response(
                        JSON.stringify({ ok: false, error: "No symbols found in sector data", date: dateParam }),
                        { status: 404, headers: withCors({ "Content-Type": "application/json" }) }
                    );
                }

                const subset = symbols.slice(offset, offset + maxSymbols);
                const engines = [env.ENGINE_1, env.ENGINE_2, env.ENGINE_3, env.ENGINE_4, env.ENGINE_5, env.ENGINE_6, env.ENGINE_7];

                // Fire-and-forget: send async=true to each engine, DO self-reports to KV
                // No need to await results — each BackfillEngine DO writes BF:{date}:{symbol} to KV when done
                const dispatched = [];
                const dispatchErrors = [];
                for (const sym of subset) {
                    let hash = 0;
                    for (let i = 0; i < sym.length; i++) hash = ((hash << 5) - hash + sym.charCodeAt(i)) | 0;
                    const engineIdx = Math.abs(hash) % 7;
                    const engine = engines[engineIdx];

                    try {
                        const engineUrl = new URL("https://engine/backfill");
                        engineUrl.searchParams.set("symbol", sym);
                        engineUrl.searchParams.set("date", dateParam);
                        engineUrl.searchParams.set("board", "RG");
                        engineUrl.searchParams.set("merge", "true");
                        engineUrl.searchParams.set("async", "true");
                        // Service binding call — engine returns 202 immediately, DO processes independently
                        await engine.fetch(engineUrl.toString());
                        dispatched.push({ symbol: sym, engine: engineIdx + 1 });
                    } catch (e) {
                        console.error(`[batch] ${sym} → engine-${engineIdx + 1} dispatch FAIL: ${e?.message}`);
                        dispatchErrors.push({ symbol: sym, engine: engineIdx + 1, error: e?.message });
                    }
                }

                // Save dispatch metadata to KV for progress tracking
                await env.SSSAHAM_WATCHLIST.put(`BF_BATCH:${dateParam}`, JSON.stringify({
                    dispatched_at: new Date().toISOString(),
                    total: subset.length,
                    dispatched: dispatched.length,
                    errors: dispatchErrors.length,
                    symbols: subset
                }), { expirationTtl: 86400 });

                // Engine distribution preview
                const enginePreview = {};
                for (const sym of subset) {
                    let hash = 0;
                    for (let i = 0; i < sym.length; i++) hash = ((hash << 5) - hash + sym.charCodeAt(i)) | 0;
                    const e = (Math.abs(hash) % 7) + 1;
                    enginePreview[`engine_${e}`] = (enginePreview[`engine_${e}`] || 0) + 1;
                }

                return new Response(JSON.stringify({
                    ok: true,
                    date: dateParam,
                    total_symbols: symbols.length,
                    dispatched: dispatched.length,
                    dispatch_errors: dispatchErrors.length,
                    engine_distribution: enginePreview,
                    sample: subset.slice(0, 20),
                    errors: dispatchErrors.length > 0 ? dispatchErrors.slice(0, 5) : undefined,
                    hint: `Check progress: GET /backfill/footprint/progress?date=${dateParam}`
                }), { status: 202, headers: withCors({ "Content-Type": "application/json" }) });
            } catch (e) {
                return new Response(
                    JSON.stringify({ ok: false, error: e?.message || String(e) }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
        }

        // ── GET /backfill/footprint/progress ─────────────────────────────────
        // Aggregate per-symbol results from KV (BF:{date}:{symbol}) to show progress.
        if (path === "/backfill/footprint/progress") {
            const dateParam = url.searchParams.get("date") || getWibDateString();
            try {
                // Read dispatch metadata
                const batch = await env.SSSAHAM_WATCHLIST.get(`BF_BATCH:${dateParam}`, { type: "json" });
                if (!batch) {
                    return new Response(JSON.stringify({ ok: false, error: "No batch dispatch found for this date" }), {
                        status: 404, headers: withCors({ "Content-Type": "application/json" })
                    });
                }

                // Scan per-symbol results via KV list
                const prefix = `BF:${dateParam}:`;
                let cursor = undefined, allKeys = [];
                for (let i = 0; i < 20; i++) {
                    const list = await env.SSSAHAM_WATCHLIST.list({ prefix, cursor, limit: 1000 });
                    allKeys.push(...list.keys);
                    if (list.list_complete) break;
                    cursor = list.cursor;
                }

                // Read a sample of results for detail
                const sampleKeys = allKeys.slice(-10);
                const sampleResults = [];
                for (const k of sampleKeys) {
                    const val = await env.SSSAHAM_WATCHLIST.get(k.name, { type: "json" });
                    if (val) sampleResults.push(val);
                }

                const completed = allKeys.length;
                const total = batch.total || batch.symbols?.length || 0;
                const backfilled = sampleResults.filter(r => r.status === "BACKFILLED").length;
                const errors = sampleResults.filter(r => r.status === "ERROR").length;
                const noTrades = sampleResults.filter(r => r.status === "NO_TRADES").length;

                return new Response(JSON.stringify({
                    ok: true,
                    date: dateParam,
                    dispatched_at: batch.dispatched_at,
                    total_dispatched: total,
                    completed,
                    remaining: Math.max(0, total - completed),
                    pct: total > 0 ? Math.round(completed / total * 100) : 0,
                    sample_last_10: sampleResults.map(r => ({
                        symbol: r.symbol, status: r.status, trades: r.trades || 0,
                        candles: r.candles || 0, elapsed_ms: r.elapsed_ms || 0,
                        time_range: r.time_range || null
                    }))
                }), { headers: withCors({ "Content-Type": "application/json" }) });
            } catch (e) {
                return new Response(
                    JSON.stringify({ ok: false, error: e?.message || String(e) }),
                    { status: 500, headers: withCors({ "Content-Type": "application/json" }) }
                );
            }
        }

        // ── GET /backfill/footprint/status ───────────────────────────────────
        // Read backfill run summary from KV.
        if (path === "/backfill/footprint/status") {
            const raw = await env.SSSAHAM_WATCHLIST.get("BACKFILL_FOOTPRINT_STATUS", { type: "json" }) || {};
            return new Response(JSON.stringify({ ok: true, ...raw }), {
                headers: withCors({ "Content-Type": "application/json" })
            });
        }

        // ── GET /backfill/footprint/debug ────────────────────────────────────
        // Debug: sends ONE page of done_detail query and returns ALL raw WS messages.
        if (path === "/backfill/footprint/debug") {
            const symbol = (url.searchParams.get("symbol") || "TLKM").toUpperCase();
            const board  = (url.searchParams.get("board") || "RG").toUpperCase();
            const pageNo = clampInt(url.searchParams.get("page"), 1, 100, 1);

            let ws;
            try {
                ws = await openIpotWs(env);
            } catch {
                await clearIpotAppSession(env);
                ws = await openIpotWs(env);
            }

            const rawMessages = [];
            const queryCmdid = 999;
            const queryCid   = 999;

            const onMsg = (ev) => {
                const txt = typeof ev.data === "string" ? ev.data : "";
                if (txt === "#1") { try { ws.send("#2"); } catch { } return; }
                rawMessages.push(txt.slice(0, 500)); // cap each message
            };

            ws.addEventListener("message", onMsg);
            ws.send(JSON.stringify({
                event: "cmd",
                data: {
                    cmdid: queryCmdid,
                    param: {
                        service: "midata",
                        cmd:     "query",
                        param: {
                            source:  "datafeed",
                            index:   "xen_qu_done_detail",
                            args:    [symbol, board],
                            info:    { pageno: pageNo, orderby: [[0, "ASC"]] },
                            pagelen: clampInt(url.searchParams.get("pagelen"), 1, 5000, 30)
                        }
                    }
                },
                cid: queryCid
            }));

            // Wait up to 8s
            const start = Date.now();
            const maxMsgs = clampInt(url.searchParams.get("maxmsgs"), 1, 10000, 50);
            while (Date.now() - start < 8000 && rawMessages.length < maxMsgs) {
                await new Promise(r => setTimeout(r, 100));
            }

            ws.removeEventListener("message", onMsg);
            try { ws.close(); } catch { }

            // Extract record lines from raw messages for quick analysis
            const records = [];
            for (const m of rawMessages) {
                try {
                    const j = JSON.parse(m);
                    if (j?.event === "record" && j?.data?.data?.rec) {
                        records.push(j.data.data.rec);
                    }
                    if (j?.event === "record" && j?.data?.recno === -1) {
                        records.push(`__FOOTER__ total=${j.data.total}`);
                    }
                } catch {}
            }

            return new Response(JSON.stringify({
                ok: true,
                symbol, board, pageNo,
                total_messages: rawMessages.length,
                total_records: records.length,
                first_record: records[0] || null,
                last_record: records[records.length - 1] || null,
                messages: rawMessages.slice(0, 20)
            }, null, 2), { headers: withCors({ "Content-Type": "application/json" }) });
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
        const backfillResults = [];

        await Promise.all(batch.messages.map(async (msg) => {
            // ── Route: Backfill Footprint → Durable Object ──────────────────
            if (msg.body?.type === "backfill_footprint") {
                const { symbol, date, board, merge } = msg.body;
                try {
                    console.log(`[sector-scrapper:queue:backfill] → DO ${symbol} date=${date}`);
                    const doId = env.BACKFILL_DO.idFromName(`BACKFILL:${symbol}:${date}`);
                    const stub = env.BACKFILL_DO.get(doId);
                    const doUrl = new URL("https://do/backfill");
                    doUrl.searchParams.set("symbol", symbol);
                    doUrl.searchParams.set("date", date);
                    doUrl.searchParams.set("board", board || "RG");
                    doUrl.searchParams.set("merge", String(merge !== false));
                    const doResp = await stub.fetch(doUrl.toString());
                    const result = await doResp.json();
                    backfillResults.push(result);
                    console.log(`[sector-scrapper:queue:backfill] DONE ${symbol} trades=${result.trades} candles=${result.candles} status=${result.status}`);
                    msg.ack();
                } catch (e) {
                    console.error(`[sector-scrapper:queue:backfill] FAIL ${symbol}: ${e?.message || e}`);
                    msg.retry();
                }
                return;
            }

            // ── Route: Sector Tape (default) ──────────────────────────────────
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
                    const w = await writeSectorSnapshotToR2(env, result);
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
                msg.retry();
            }
        }));

        // Persist sector run summary to KV (best-effort)
        if (sectorSummaries.length > 0) {
            try {
                const existing = await env.SSSAHAM_WATCHLIST.get("SECTOR_TAPE_LAST_RUN", { type: "json" }) || {};
                const updated  = { ...existing, run_at: runAt };
                for (const s of sectorSummaries) updated[s.sector] = s;
                await env.SSSAHAM_WATCHLIST.put("SECTOR_TAPE_LAST_RUN", JSON.stringify(updated), { expirationTtl: 86400 });
            } catch { }
        }

        // Persist backfill progress to KV (best-effort)
        if (backfillResults.length > 0) {
            try {
                const existing = await env.SSSAHAM_WATCHLIST.get("BACKFILL_FOOTPRINT_STATUS", { type: "json" }) || {};
                const updated = {
                    ...existing,
                    last_run_at: runAt,
                    total_processed: (existing.total_processed || 0) + backfillResults.length,
                    total_trades:    (existing.total_trades    || 0) + backfillResults.reduce((s, r) => s + (r.trades || 0), 0),
                    total_candles:   (existing.total_candles   || 0) + backfillResults.reduce((s, r) => s + (r.candles || 0), 0),
                    last_symbols:    backfillResults.map(r => ({
                        symbol: r.symbol,
                        trades: r.trades,
                        candles: r.candles,
                        status: r.status,
                        time_range: r.time_range
                    }))
                };
                await env.SSSAHAM_WATCHLIST.put("BACKFILL_FOOTPRINT_STATUS", JSON.stringify(updated), { expirationTtl: 86400 });
            } catch { }
        }
    }
};
