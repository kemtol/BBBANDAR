/**
 * @worker livetrade-durable-object
 * @objective Stateful engine for processing live trade stream, deduplicating, aggregating into candles/footprint, and ensuring consistency.
 *
 * @endpoints
 * - POST /trade-batch -> Ingest trade batch (internal/public)
 * - POST /update -> Legacy single update (internal)
 * - POST /batch-update -> Legacy batch update (internal)
 * - GET /snapshot -> Get current state/candles (internal/debug)
 * - GET /status -> Get engine status metrics (internal/debug)
 *
 * @triggers
 * - http: yes (via wrapper)
 * - cron: none
 * - queue: none
 * - durable_object: StateEngine
 * - alarms: yes (Flush/Prune every 5s)
 *
 * @io
 * - reads: R2 (footprint for merging)
 * - writes: R2 (raw_trades, footprint), Queue (PROCESSED_QUEUE)
 *
 * @relations
 * - upstream: Trade Stream Producer (unknown source) (via fetch)
 * - downstream: livetrade-taping-agregator (via livetrade-processed-queue)
 *
 * @success_metrics
 * - Deduplication rate
 * - Ingest throughput (trades/sec)
 * - Flush latency (alarm execution time)
 *
 * @notes
 * - Handles both legacy and new 'GEN-2' trade formats.
 * - Uses SHA-256 for deduplication.
 */

// Helper: Simple Hash for Dedupe
async function generateHash(str) {
    const msgBuffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export class StateEngine {
    constructor(state, env) {
        this.state = state;
        this.env = env;

        // In-memory storage: Map<ticker, Map<timeKey, CandleData>>
        // CandleData structure matches footprint.html expectations
        this.tickers = new Map();

        // Intraday Pipeline State
        this.dedupeMap = new Map(); // Map<hash_id, timestamp>
        this.rawBuffer = []; // Array<CTE>
        this.lastRawFlush = Date.now();
        this.lastFootprintFlush = Date.now();
        this.lastQueueSend = Date.now();
        this.lastError = "";

        // C5: Dirty hours tracking for efficient flush
        this.dirtyHours = new Set(); // Set<r2Key>

        // R6: Per-key write lock serialization
        this.writeLocks = new Map(); // Map<r2Key, Promise>

        // Thresholds
        this.RAW_FLUSH_INTERVAL = 5000; // 5s
        this.RAW_BATCH_SIZE = 500;
        this.DEDUPE_TTL = 300000; // 5 mins
    }

    async fetch(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // NEW: Batch Entry Point (Straight-Through Ingest)
        if (pathname === "/trade-batch") {
            const batch = await request.json();
            const result = await this.processBatch(batch);
            return Response.json(result);
        }

        // LEGACY/DIRECT: Update Single
        if (pathname === "/update") {
            // Input: { ticker: "GOTO", price: 50, side: "buy", vol: 100, timestamp: ... }
            const req = await request.json();
            await this.processTradeLegacy(req);
            return new Response("ok");
        }

        // LEGACY/DIRECT: Batch Update
        if (pathname === "/batch-update") {
            const trades = await request.json(); // Expect array of trades
            if (Array.isArray(trades)) {
                for (const trade of trades) {
                    await this.processTradeLegacy(trade);
                }
            }
            return new Response("ok");
        }

        if (pathname === "/snapshot") {
            const ticker = url.searchParams.get("ticker");
            const candles = this.getTickerData(ticker);
            return Response.json({ ticker, candles });
        }

        // C4: Expanded /status observability
        if (pathname === "/status") {
            let candles_count_total = 0;
            for (const [, map] of this.tickers.entries()) {
                candles_count_total += map.size;
            }

            return Response.json({
                tickers_count: this.tickers.size,
                candles_count_total,
                rawBuffer_len: this.rawBuffer.length,
                dedupe_size: this.dedupeMap.size,
                dirtyHours_count: this.dirtyHours.size,
                locksCount: this.writeLocks.size,
                lastRawFlushIso: new Date(this.lastRawFlush).toISOString(),
                lastFootprintFlushIso: new Date(this.lastFootprintFlush).toISOString(),
                lastQueueSendIso: new Date(this.lastQueueSend).toISOString(),
                lastError: this.lastError.slice(-200),
            });
        }

        // R10: Debug endpoint for verifying hour file contents
        if (pathname === "/debug/hour") {
            const ticker = url.searchParams.get("ticker");
            const y = url.searchParams.get("y");
            const m = url.searchParams.get("m");
            const d = url.searchParams.get("d");
            const h = url.searchParams.get("h");

            if (!ticker || !y || !m || !d || !h) {
                return Response.json({ error: "Missing params: ticker, y, m, d, h" }, { status: 400 });
            }

            const key = `footprint/${ticker}/1m/${y}/${m}/${d}/${h}.jsonl`;
            try {
                const obj = await this.env.DATA_LAKE.get(key);
                if (!obj) return Response.json({ error: "File not found", key });

                const text = await obj.text();
                const lines = text.split("\n").filter(l => l.trim());
                const t0s = [];
                let anyOutOfHour = 0;

                for (const line of lines) {
                    try {
                        const c = JSON.parse(line);
                        if (c.t0) {
                            t0s.push(c.t0);
                            // Check if t0 hour matches file hour
                            const dt = new Date(c.t0);
                            const candleH = String(dt.getUTCHours()).padStart(2, "0");
                            if (candleH !== h) anyOutOfHour++;
                        }
                    } catch (e) { }
                }

                return Response.json({
                    key,
                    linesCount: lines.length,
                    uniqueT0Count: new Set(t0s).size,
                    minT0: t0s.length ? Math.min(...t0s) : null,
                    maxT0: t0s.length ? Math.max(...t0s) : null,
                    anyOutOfHourCount: anyOutOfHour,
                });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        }

        return new Response("Not found", { status: 404 });
    }

    // --- PIPELINE LOGIC ---

    async processBatch(batch) {
        let accepted = 0;
        let deduped = 0;
        let errors = 0;

        if (!Array.isArray(batch)) return { error: "Batch must be array" };

        for (const item of batch) {
            try {
                const cte = await this.normalizeToCTE(item);
                if (!cte) {
                    errors++;
                    continue;
                }

                // Deduplicate
                if (this.dedupeMap.has(cte.hash_id)) {
                    deduped++;
                    continue;
                }
                this.dedupeMap.set(cte.hash_id, Date.now());

                // Accept
                accepted++;

                // 1. Fan-Out RAW
                this.rawBuffer.push(cte);

                // 2. Fan-Out FOOTPRINT
                this.updateFootprint(cte);

                // 3. Fan-Out PROCESSED (Future Phase 2)
                // this.notifyProcessedBuilder(cte);

            } catch (e) {
                console.error("CTE Error", e);
                errors++;
            }
        }

        // Check Flush
        await this.checkFlush();

        return { accepted, deduped, errors };
    }

    async normalizeToCTE(rawItem) {
        // Handle GEN-2 Object vs Legacy Pipe input
        // Expected inputs:
        // 1. { v:2, fmt:"obj", ts, raw:{...} }
        // 2. { v:2, fmt:"pipe", ts, raw:"A|B|..." }
        // 3. Simple Object { ticker, price, vol, timestamp } (Legacy / Internal)

        let ts_ms, ticker, board, price, qty, src;
        const v = rawItem.v || 1;
        const fmt = rawItem.fmt || "unknown";

        // Try extract from standard fields first
        ts_ms = Number(rawItem.ts || rawItem.timestamp || Date.now());
        src = rawItem.src || "unknown";

        if (fmt === "pipe" || (typeof rawItem.raw === "string" && rawItem.raw.includes("|"))) {
            const parts = rawItem.raw.split("|");
            // Pipe: YYYYMMDD|HHMMSS|X|CODE|BOARD|TYPE|PRICE|VOL
            if (parts.length < 8) return null;
            ticker = parts[3];
            board = parts[4];
            price = Number(parts[6]);
            qty = Number(parts[7]);
            // Re-derive TS if needed? Use passed TS for now.
        }
        else if (fmt === "obj" || typeof rawItem.raw === "object") {
            const r = rawItem.raw || rawItem;
            ticker = r.code || r.symbol || r.ticker || r.kode;
            board = r.board || r.papan || "RG";
            price = Number(r.price || r.last || r.harga);
            qty = Number(r.volume || r.vol || r.qty || r.amount);
            // Internal override
            if (!price && r.price) price = Number(r.price);
        }
        else {
            // Fallback for simple object (Legacy / Internal Batch)
            ticker = rawItem.ticker;
            price = Number(rawItem.price);
            qty = Number(rawItem.amount || rawItem.vol);
            board = "RG"; // Assumption
        }

        // Validate
        if (!ticker || board !== "RG" || !Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) {
            return null;
        }

        // R1: ALL UTC - derive date/time labels from ts_ms (UTC)
        const dt = new Date(ts_ms);
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dt.getUTCDate()).padStart(2, '0');
        const hh = String(dt.getUTCHours()).padStart(2, '0');
        const mm = String(dt.getUTCMinutes()).padStart(2, '0');
        const ss = String(dt.getUTCSeconds()).padStart(2, '0');

        const date_utc = `${y}-${m}-${dd}`;
        const hhmmss_utc = `${hh}${mm}${ss}`;

        // PATCH B1: Dedupe key must include raw string for pipe to avoid collapsing trades in same second
        let hashKey;
        if ((fmt === "pipe" || (typeof rawItem.raw === "string" && String(rawItem.raw).includes("|"))) && typeof rawItem.raw === "string") {
            hashKey = `${src}|pipe|${rawItem.raw}`; // dedupe by exact record
        } else if ((fmt === "obj" || typeof rawItem.raw === "object") && rawItem.raw) {
            hashKey = `${src}|obj|${JSON.stringify(rawItem.raw)}`;
        } else {
            hashKey = `${ticker}|${ts_ms}|${price}|${qty}|${src}`;
        }
        const hash_id = await generateHash(hashKey);

        return {
            v: 2,
            ts_ms,
            date_utc,
            hhmmss_utc,
            ticker,
            board,
            price,
            qty,
            src,
            hash_id
        };
    }

    // --- FOOTPRINT STATE ---

    updateFootprint(cte) {
        // 1. Get Ticker Map
        let tickerData = this.tickers.get(cte.ticker);
        if (!tickerData) {
            tickerData = new Map();
            this.tickers.set(cte.ticker, tickerData);
        }

        // R3: Time Bucket (1 Minute) based on UTC
        // Use cte.ts_ms (UTC) for candle bucketing and file partitioning
        const ts = new Date(cte.ts_ms);
        ts.setUTCSeconds(0, 0);
        ts.setUTCMilliseconds(0);
        const timeKey = ts.getTime();

        // 3. Get/Create Candle
        let candle = tickerData.get(timeKey);
        if (!candle) {
            candle = {
                t0: timeKey,
                ohlc: { o: cte.price, h: cte.price, l: cte.price, c: cte.price },
                vol: 0,
                delta: 0,
                levels: []
            };
            tickerData.set(timeKey, candle);
        }

        // 4. Update Stats
        candle.ohlc.h = Math.max(candle.ohlc.h, cte.price);
        candle.ohlc.l = Math.min(candle.ohlc.l, cte.price);
        candle.ohlc.c = cte.price;
        candle.vol += cte.qty;

        // PATCH 4: Side Inference using Uptick Rule
        if (candle._lastPrice == null) candle._lastPrice = cte.price;

        let side = 'neutral';
        if (cte.price > candle._lastPrice) side = 'buy';
        else if (cte.price < candle._lastPrice) side = 'sell';
        candle._lastPrice = cte.price;

        // Update delta based on inferred side
        if (side === 'buy') candle.delta += cte.qty;
        else if (side === 'sell') candle.delta -= cte.qty;

        // Levels
        let level = candle.levels.find(l => l.p === cte.price);
        if (!level) {
            level = { p: cte.price, bv: 0, av: 0 };
            candle.levels.push(level);
        }
        // Update BV/AV based on inferred side
        if (side === 'buy') level.bv += cte.qty;
        else if (side === 'sell') level.av += cte.qty;

        // C5: Mark hour as dirty for efficient flush
        const dt = new Date(timeKey);
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const d = String(dt.getUTCDate()).padStart(2, '0');
        const h = String(dt.getUTCHours()).padStart(2, '0');
        const r2Key = `footprint/${cte.ticker}/1m/${y}/${m}/${d}/${h}.jsonl`;
        this.dirtyHours.add(r2Key);
    }

    async processTradeLegacy(trade) {
        const cte = await this.normalizeToCTE(trade);
        if (cte) {
            if (!this.dedupeMap.has(cte.hash_id)) {
                this.dedupeMap.set(cte.hash_id, Date.now());
                this.updateFootprint(cte); // No raw fan-out for legacy endpoint to avoid double buffer
            }
        }
    }

    async checkFlush() {
        const now = Date.now();

        // Check Raw Buffer
        if (this.rawBuffer.length >= this.RAW_BATCH_SIZE || (now - this.lastRawFlush) >= this.RAW_FLUSH_INTERVAL) {
            // Trigger Alarm immediately or just flush?
            // Since we are in request context, we can flush if quick, or schedule alarm.
            // Better to schedule alarm to unblock request.
            // But user wants "Straight Through".
            // Let's rely on Alarm for actual heavy IO, but ensure alarm is set.
        }

        const currentAlarm = await this.state.storage.getAlarm();
        if (!currentAlarm) {
            this.state.storage.setAlarm(Date.now() + 2000); // Check in 2s
        }
    }

    async alarm() {
        await this.flushRawTrades();
        await this.flushFootprint();
        this.pruneDedupe();
        this.state.storage.setAlarm(Date.now() + 5000);
    }

    async flushRawTrades() {
        if (this.rawBuffer.length === 0) return;

        const batch = this.rawBuffer.splice(0, this.rawBuffer.length); // Take all

        // Group by folder: raw_trades/YYYY-MM-DD/HH (UTC)
        const grouped = {};
        for (const cte of batch) {
            const key = `raw_trades/${cte.date_utc}/${cte.hhmmss_utc.slice(0, 2)}/`;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(cte);
        }

        const now = Date.now();
        await Promise.all(Object.entries(grouped).map(async ([prefix, items]) => {
            const uuid = crypto.randomUUID();
            const filename = `${now}_${uuid}.jsonl`;
            const path = `${prefix}${filename}`;
            const body = items.map(i => JSON.stringify(i)).join("\n");

            await this.env.DATA_LAKE.put(path, body);
        }));

        this.lastRawFlush = now;
    }

    pruneDedupe() {
        const now = Date.now();
        for (const [k, ts] of this.dedupeMap.entries()) {
            if (now - ts > this.DEDUPE_TTL) {
                this.dedupeMap.delete(k);
            }
        }
    }

    async flushFootprint() {
        // C5: Only process dirty hours for efficiency
        if (this.dirtyHours.size === 0) return;

        const dirtyKeys = Array.from(this.dirtyHours);
        this.dirtyHours.clear(); // Clear before processing to avoid race conditions

        // Group candles by dirty R2 keys
        const grouped = {}; // key -> [candleObj, ...]
        const notifiedSet = new Set();

        for (const r2Key of dirtyKeys) {
            // Extract ticker from r2Key: footprint/TICKER/1m/YYYY/MM/DD/HH.jsonl
            const parts = r2Key.split("/");
            const ticker = parts[1];
            const y = parts[3];
            const m = parts[4];
            const d = parts[5];
            const h = parts[6].replace(".jsonl", "");

            if (!this.tickers.has(ticker)) continue;
            const tickerData = this.tickers.get(ticker);

            // Get all candles for this hour
            const candles = [];
            for (const [timeKey, candle] of tickerData.entries()) {
                const dt = new Date(timeKey);
                const candleH = String(dt.getUTCHours()).padStart(2, "0");
                const candleD = String(dt.getUTCDate()).padStart(2, "0");
                const candleM = String(dt.getUTCMonth() + 1).padStart(2, "0");
                const candleY = String(dt.getUTCFullYear());

                if (candleH === h && candleD === d && candleM === m && candleY === y) {
                    candles.push(candle);
                    notifiedSet.add(JSON.stringify({ ticker, timeKey, y, m, d, h }));
                }
            }

            if (candles.length > 0) {
                grouped[r2Key] = candles;
            }
        }

        // Write each group
        for (const [key, candles] of Object.entries(grouped)) {
            await this.writeBatchToHourlyFootprintJsonl(key, candles);
        }

        // Notify Processed Builder (Queue)
        if (this.env.PROCESSED_QUEUE && notifiedSet.size > 0) {
            const messages = [];
            for (const itemStr of notifiedSet) {
                const item = JSON.parse(itemStr);
                messages.push({
                    body: {
                        type: "minute_finalized",
                        ticker: item.ticker,
                        timeKey: item.timeKey,
                        hourPrefix: `${item.y}/${item.m}/${item.d}/${item.h}`,
                        source: "footprint",
                        ts: Date.now()
                    }
                });
            }

            for (let i = 0; i < messages.length; i += 100) {
                try {
                    await this.env.PROCESSED_QUEUE.sendBatch(messages.slice(i, i + 100));
                } catch (e) {
                    console.error("Queue Error", e);
                }
            }
            this.lastQueueSend = Date.now();
        }

        this.lastFootprintFlush = Date.now();

        // Cleanup old memory (> 2 hours)
        const now = Date.now();
        for (const [ticker, map] of this.tickers.entries()) {
            for (const timeKey of map.keys()) {
                if (now - timeKey > 7200000) {
                    map.delete(timeKey);
                }
            }
        }

    }

    async writeBatchToHourlyFootprintJsonl(key, newCandles) {
        // R6: Per-key write lock serialization
        const prev = this.writeLocks.get(key) || Promise.resolve();
        const next = prev.then(() => this.doWriteMerge(key, newCandles)).catch(e => {
            console.error(`Write merge failed for ${key}:`, e);
            this.lastError = String(e);
        });
        this.writeLocks.set(key, next);
        await next;
    }

    async doWriteMerge(key, newCandles) {
        // Read existing
        let existing = "";
        try {
            const obj = await this.env.DATA_LAKE.get(key);
            if (obj) existing = await obj.text();
        } catch (e) {
            // New file
        }

        const lines = existing ? existing.split("\n").filter(l => l.trim().length > 0) : [];

        // R7: Merge Map keyed by t0 (number) for idempotency
        const mergedMap = new Map();

        // 1. Load existing
        for (const line of lines) {
            try {
                const c = JSON.parse(line);
                if (c && c.t0) mergedMap.set(c.t0, line);
            } catch (e) { /* skip malformed */ }
        }

        // 2. PATCH B3: Sanitize and overwrite with new candles (remove internal fields like _lastPrice)
        const sanitizeCandle = (c) => ({
            t0: c.t0,
            ohlc: c.ohlc,
            vol: c.vol,
            delta: c.delta,
            levels: Array.isArray(c.levels) ? c.levels : []
        });
        for (const c of newCandles) {
            mergedMap.set(c.t0, JSON.stringify(sanitizeCandle(c)));
        }

        // 3. Convert back to sorted array (ascending by t0)
        const sortedKeys = Array.from(mergedMap.keys()).sort((a, b) => a - b);
        const finalLines = sortedKeys.map(k => mergedMap.get(k));
        const body = finalLines.join("\n") + "\n";

        await this.env.DATA_LAKE.put(key, body, {
            httpMetadata: { contentType: "application/x-ndjson" }
        });
    }

    getTickerData(ticker) {
        if (!ticker || !this.tickers.has(ticker)) return [];
        // Return array of candles, sorted by time
        const map = this.tickers.get(ticker);
        return Array.from(map.values()).sort((a, b) => a.t0 - b.t0);
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const id = env.STATE_ENGINE.idFromName("GLOBAL_V2_ENGINE"); // Singleton for simplicity initially
        const obj = env.STATE_ENGINE.get(id);
        return obj.fetch(request);
    }
};
