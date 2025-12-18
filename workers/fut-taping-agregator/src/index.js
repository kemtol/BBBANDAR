export default {
    async fetch(request, env, ctx) {
        // Simple manual trigger or cron trigger
        const url = new URL(request.url);

        // Define targets
        const TIME_FRAME = "1m"; // Fixed for now
        const SYMBOL = "ENQ";    // Target symbol
        const BAR_MS = 60000;

        // Example trigger: /?symbol=ENQ&date=2025-12-17&hour=13
        // If not provided, default to "current hour" or "last hour"

        let targetDate = new Date();
        // If manual override parameters are present
        if (url.searchParams.get("date")) {
            const dateStr = url.searchParams.get("date"); // YYYY-MM-DD
            const hourStr = url.searchParams.get("hour"); // HH
            if (dateStr && hourStr) {
                targetDate = new Date(`${dateStr}T${hourStr}:00:00Z`);
            }
        }

        // Construct paths
        const y = targetDate.getUTCFullYear();
        const m = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getUTCDate()).padStart(2, '0');
        const h = String(targetDate.getUTCHours()).padStart(2, '0');

        const rawPrefix = `raw_tns/${SYMBOL}/${y}/${m}/${d}/${h}`;
        const outputPath = `footprint/${SYMBOL}/${TIME_FRAME}/${y}/${m}/${d}/${h}.json`;

        console.log(`[Agregator] Processing ${rawPrefix} -> ${outputPath}`);

        // 1. List all raw files in that hour
        let listed = await env.DATA_LAKE.list({ prefix: rawPrefix });
        let files = listed.objects;
        while (listed.truncated) {
            listed = await env.DATA_LAKE.list({ prefix: rawPrefix, cursor: listed.cursor });
            files = [...files, ...listed.objects];
        }

        if (files.length === 0) {
            return Response.json({ message: "No raw files found", prefix: rawPrefix });
        }

        console.log(`[Agregator] Found ${files.length} raw files`);

        // 2. Read and Aggregate
        // Optimization: Process in chunks if too many files. For now, assume manageable count per hour.

        // State
        const candles = {}; // timestamp -> candle object
        let bestBid = 0;
        let bestAsk = 0;

        for (const file of files) {
            const object = await env.DATA_LAKE.get(file.key);
            if (!object) continue;

            const content = await object.text();
            const lines = content.split('\n').filter(l => l.trim());

            for (const line of lines) {
                try {
                    const wrapper = JSON.parse(line);
                    const rawMsg = wrapper.raw;
                    if (!rawMsg) continue;

                    const payloads = rawMsg.split('\u001e').filter(p => p.trim());
                    for (const p of payloads) {
                        const msg = JSON.parse(p);

                        // Quote Context
                        if (msg.target === 'RealTimeSymbolQuote') {
                            const quote = msg.arguments[0];
                            // Check symbols (raw quote uses F.US.ENQ)
                            if (quote.symbol === `F.US.${SYMBOL}` || quote.symbol === SYMBOL) {
                                if (quote.bestBid) bestBid = quote.bestBid;
                                if (quote.bestAsk) bestAsk = quote.bestAsk;
                            }
                        }

                        // Trade Data
                        if (msg.target === 'RealTimeTradeLogWithSpeed') {
                            const tradeData = msg.arguments[1];
                            if (Array.isArray(tradeData)) {
                                for (const trade of tradeData) {
                                    processTrade(trade, bestBid, bestAsk, candles, SYMBOL, BAR_MS);
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Ignore parse errors line by line
                }
            }
        }

        // 3. Finalize and Output
        const resultCandles = [];
        const sortedTimes = Object.keys(candles).sort();

        for (const t of sortedTimes) {
            const c = candles[t];
            finalizeCandle(c);
            resultCandles.push(c);
        }

        // 4. Save to R2
        if (resultCandles.length > 0) {
            await env.DATA_LAKE.put(outputPath, JSON.stringify(resultCandles));
            console.log(`[Agregator] Saved ${resultCandles.length} candles to ${outputPath}`);
        }

        return Response.json({
            success: true,
            filesProcessed: files.length,
            candlesGenerated: resultCandles.length,
            path: outputPath
        });
    }
};

function processTrade(trade, currentBid, currentAsk, candles, symbol, barMs) {
    const ts = new Date(trade.timestamp).getTime();
    const bucketTs = Math.floor(ts / barMs) * barMs;

    // Init Candle
    if (!candles[bucketTs]) {
        const t0 = new Date(bucketTs);
        const t1 = new Date(bucketTs + barMs);

        candles[bucketTs] = {
            v: 1,
            symbol: `F.US.${symbol}`, // Standardize
            tick: 0.25, // Hardcoded for NQ/ENQ for now
            bar_ms: barMs,
            t0: t0.toISOString(),
            t1: t1.toISOString(),
            time: bucketTs, // Temporary for sorting
            ohlc: { o: trade.price, h: trade.price, l: trade.price, c: trade.price },
            vol: 0,
            delta: 0,
            total_bid: 0, // Integrity check field
            total_ask: 0, // Integrity check field
            profile: {} // price -> {bid: 0, ask: 0}
        };
    }

    const c = candles[bucketTs];

    // OHLC
    c.ohlc.h = Math.max(c.ohlc.h, trade.price);
    c.ohlc.l = Math.min(c.ohlc.l, trade.price);
    c.ohlc.c = trade.price;
    c.vol += trade.volume;

    // Aggressor Logic
    let isBuy = false;
    if (currentAsk > 0 && currentBid > 0) {
        if (trade.price >= currentAsk) isBuy = true;
        else if (trade.price <= currentBid) isBuy = false;
        else isBuy = (trade.type === 1);
    } else {
        isBuy = (trade.type === 1);
    }

    // Profile
    const pStr = trade.price.toString();
    if (!c.profile[pStr]) c.profile[pStr] = { bid: 0, ask: 0 };

    if (isBuy) {
        c.delta += trade.volume;
        c.total_ask += trade.volume;
        c.profile[pStr].ask += trade.volume;
    } else {
        c.delta -= trade.volume;
        c.total_bid += trade.volume;
        c.profile[pStr].bid += trade.volume;
    }
}

function finalizeCandle(c) {
    let maxVol = -1;
    let pocPrice = 0;
    const levels = [];

    const prices = Object.keys(c.profile).map(parseFloat).sort((a, b) => a - b);

    for (const p of prices) {
        const stats = c.profile[p.toString()];
        const total = stats.bid + stats.ask;

        if (total > maxVol) {
            maxVol = total;
            pocPrice = p;
        }

        levels.push([p, stats.bid, stats.ask]);
    }

    c.poc = pocPrice;
    c.levels = levels;

    // Integrity Assertions
    const sumVol = c.total_ask + c.total_bid;
    const calcDelta = c.total_ask - c.total_bid;

    if (sumVol !== c.vol) {
        console.warn(`[Integrity Fail] Vol Mismatch! Vol:${c.vol} Sum:${sumVol} @ ${c.t0}`);
        c.integrity_error = "vol_mismatch";
    }

    if (calcDelta !== c.delta) {
        console.warn(`[Integrity Fail] Delta Mismatch! Delta:${c.delta} Calc:${calcDelta} @ ${c.t0}`);
        c.integrity_error = "delta_mismatch";
    }

    delete c.profile;
    delete c.time;
}
