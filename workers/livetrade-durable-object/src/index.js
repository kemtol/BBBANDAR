
export class StateEngine {
    constructor(state, env) {
        this.state = state;
        this.env = env;

        // In-memory storage: Map<ticker, Map<timeKey, CandleData>>
        // CandleData structure matches footprint.html expectations
        this.tickers = new Map();
    }

    async fetch(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (pathname === "/update") {
            // Input: { ticker: "GOTO", price: 50, side: "buy", vol: 100, timestamp: ... }
            const req = await request.json();
            await this.processTrade(req);
            return new Response("ok");
        }

        if (pathname === "/batch-update") {
            const trades = await request.json(); // Expect array of trades
            if (Array.isArray(trades)) {
                for (const trade of trades) {
                    await this.processTrade(trade);
                }
            }
            return new Response("ok");
        }

        if (pathname === "/snapshot") {
            const ticker = url.searchParams.get("ticker");
            const candles = this.getTickerData(ticker);
            return Response.json({ ticker, candles });
        }

        return new Response("Not found", { status: 404 });
    }

    async processTrade(trade) {
        // trade: { ticker, price, amount, side ('buy'|'sell'), timestamp }
        const { ticker, price, amount, side, timestamp } = trade;

        // 1. Get or Create Ticker Map
        let tickerData = this.tickers.get(ticker);
        if (!tickerData) {
            tickerData = new Map(); // Map<timeKey_1min, Candle>
            this.tickers.set(ticker, tickerData);
        }

        // 2. Determine Time Bucket (e.g., 1 Minute Candle)
        // NOTE: For 'Footprint', we usually want granular candles (1 min, 5 min).
        // Let's default to 1 minute buckets for now.
        const ts = new Date(timestamp || Date.now());
        ts.setSeconds(0, 0);
        const timeKey = ts.getTime();

        // 3. Get or Create Candle
        let candle = tickerData.get(timeKey);
        if (!candle) {
            candle = {
                t0: timeKey,
                ohlc: { o: price, h: price, l: price, c: price },
                vol: 0,
                delta: 0,
                levels: [] // Array of { p, bv, av }
            };
            tickerData.set(timeKey, candle);
        }

        // 4. Update OHLC
        candle.ohlc.h = Math.max(candle.ohlc.h, price);
        candle.ohlc.l = Math.min(candle.ohlc.l, price);
        candle.ohlc.c = price;

        // 5. Update Volume & Delta
        candle.vol += amount;
        if (side === 'buy') candle.delta += amount;
        else candle.delta -= amount;

        // 6. Update Levels (Volume at Price)
        // Find existing level for this price
        let level = candle.levels.find(l => l.p === price);
        if (!level) {
            level = { p: price, bv: 0, av: 0 };
            candle.levels.push(level);
        }

        // Increment Buy/Sell Volume
        if (side === 'buy') level.bv += amount;
        else level.av += amount; // 'av' = Ask Volume (Sell side execution)

        // Trigger Alarm to save data periodically (e.g., every minute)
        // In production, optimize this to not reset alarm if already set.
        const currentAlarm = await this.state.storage.getAlarm();
        if (!currentAlarm) {
            this.state.storage.setAlarm(Date.now() + 60000); // 1 minute from now
        }
    }

    async alarm() {
        // Flush all complete candles to R2
        const now = Date.now();
        const buckets = Array.from(this.tickers.values()).flatMap(m => Array.from(m.keys()));

        // For each ticker, check ready minutes
        for (const [ticker, map] of this.tickers.entries()) {
            for (const [timeKey, candle] of map.entries()) {
                // If candle is "complete" (e.g. it's from a past minute), write it.
                // Simple logic: Write EVERYTHING that has changed.
                // Better logic: Only write past minutes.
                // Let's assume we write current minute as well for realtime feel (idempotent write).

                await this.writeToHourlyFootprintJsonl(ticker, timeKey, candle);

                // If it's old (> 2 hours), remove from memory to save RAM
                if (now - timeKey > 7200000) {
                    map.delete(timeKey);
                }
            }
        }

        // Schedule next save
        this.state.storage.setAlarm(Date.now() + 60000);
    }

    async writeToHourlyFootprintJsonl(ticker, bucketTs, candleObj) {
        const dt = new Date(bucketTs);
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const d = String(dt.getUTCDate()).padStart(2, "0");
        const h = String(dt.getUTCHours()).padStart(2, "0");

        // KEY FORMAT: footprint/SYMBOL/TF/YYYY/MM/DD/HH.jsonl
        const key = `footprint/${ticker}/1m/${y}/${m}/${d}/${h}.jsonl`;

        // Read existing content (optimistic concurrency for now, or just append?)
        // R2 doesn't support append. We must Read-Modify-Write.
        // This is expensive. For high traffic, we should buffer in DO and write less often.
        // For now: Read full file, replace/append line, write back.

        let existing = "";
        try {
            const obj = await this.env.DATA_LAKE.get(key);
            if (obj) existing = await obj.text();
        } catch (e) { console.warn("Read failed (new file?)", key); }

        const lines = existing ? existing.split("\n").filter(Boolean) : [];
        const line = JSON.stringify(candleObj);

        // Idempotent Update: Remove old version of this minute if exists
        const minuteId = candleObj.t0; // t0 is the identifier
        const newLines = lines.filter(l => {
            try { return JSON.parse(l).t0 !== minuteId; } catch { return false; }
        });

        newLines.push(line);

        // Sort by time
        newLines.sort((a, b) => {
            try { return JSON.parse(a).t0 - JSON.parse(b).t0; } catch { return 0; }
        });

        const body = newLines.join("\n") + "\n";

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
