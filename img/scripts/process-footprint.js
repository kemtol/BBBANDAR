const fs = require('fs');

// Sample file path (Download dari R2 ke sini dulu)
const SAMPLE_FILE = '/tmp/enq_data.json';

// Configuration
const BAR_MS = 60000; // 1 Minute
const SYMBOL = "F.US.ENQ";
const TICK_SIZE = 0.25;

function processFile() {
    if (!fs.existsSync(SAMPLE_FILE)) {
        console.error("Sample file not found at", SAMPLE_FILE);
        return;
    }

    const content = fs.readFileSync(SAMPLE_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    console.log(`Processing ${lines.length} messages...`);

    // State
    const candles = {}; // timestamp -> candle object
    let bestBid = 0;
    let bestAsk = 0;

    for (const line of lines) {
        try {
            const wrapper = JSON.parse(line);
            // Parse raw SignalR message (string inside "raw")
            const rawMsg = wrapper.raw;
            if (!rawMsg) continue;

            // Raw message can contain multiple SignalR payloads joined by \u001e
            const payloads = rawMsg.split('\u001e').filter(p => p.trim());

            for (const p of payloads) {
                const msg = JSON.parse(p);

                // 1. Process Quotes (untuk context Aggressor)
                if (msg.target === 'RealTimeSymbolQuote') {
                    const quote = msg.arguments[0];
                    if (quote.symbol === SYMBOL) {
                        if (quote.bestBid) bestBid = quote.bestBid;
                        if (quote.bestAsk) bestAsk = quote.bestAsk;
                    }
                }

                // 2. Process Trade Log
                if (msg.target === 'RealTimeTradeLogWithSpeed') {
                    const tradeData = msg.arguments[1]; // Array of trades
                    if (!Array.isArray(tradeData)) continue;

                    for (const trade of tradeData) {
                        processTrade(trade, bestBid, bestAsk, candles);
                    }
                }
            }
        } catch (e) {
            console.error("Parse error:", e.message);
        }
    }

    // Output Result
    // Convert map to sorted array
    const sortedTimes = Object.keys(candles).sort();
    for (const t of sortedTimes) {
        const c = candles[t];
        finalizeCandle(c);
        console.log("------------------------------------------------");
        console.log(`Candle: ${c.t0} (${c.time})`);
        console.log(`OHLC: ${c.ohlc.o} ${c.ohlc.h} ${c.ohlc.l} ${c.ohlc.c} Vol: ${c.vol} Delta: ${c.delta}`);
        console.log(`POC: ${c.poc}`);
        console.log(`Levels (Top 5 Vol):`, c.levels.sort((a, b) => (b[1] + b[2]) - (a[1] + a[2])).slice(0, 5));

        // Output full usage JSON format for user review
        // console.log(JSON.stringify(c, null, 2));
    }
}

function processTrade(trade, currentBid, currentAsk, candles) {
    // trade: { price, volume, timestamp, type, ... }
    const ts = new Date(trade.timestamp).getTime();

    // Bucket Timestamp
    const bucketTs = Math.floor(ts / BAR_MS) * BAR_MS;
    const t0Str = new Date(bucketTs).toISOString();
    const t1Str = new Date(bucketTs + BAR_MS).toISOString();

    // Init Candle if needed
    if (!candles[bucketTs]) {
        candles[bucketTs] = {
            v: 1,
            symbol: SYMBOL,
            tick: TICK_SIZE,
            bar_ms: BAR_MS,
            t0: t0Str,
            t1: t1Str,
            time: bucketTs, // Helper field
            ohlc: { o: trade.price, h: trade.price, l: trade.price, c: trade.price },
            vol: 0,
            delta: 0,
            profile: {} // price -> {bid: 0, ask: 0}
        };
    }

    const c = candles[bucketTs];

    // Update OHLC
    c.ohlc.h = Math.max(c.ohlc.h, trade.price);
    c.ohlc.l = Math.min(c.ohlc.l, trade.price);
    c.ohlc.c = trade.price;
    c.vol += trade.volume;

    // Determine Aggressor
    // Strategy: Use 'type' if explicit known logic, else Price vs Quote.
    // Hypothesis: type 1 = Buy (Ask Aggressor), type 2 = Sell (Bid Aggressor).
    // Let's test this hypothesis with Price vs Quote comparison logic.

    let isBuy = false;

    // Logic A: Price comparison (Gold Standard if Quotes are available)
    if (currentAsk > 0 && currentBid > 0) {
        if (trade.price >= currentAsk) isBuy = true;
        else if (trade.price <= currentBid) isBuy = false;
        else {
            // Mid-spread trade: use logic B (tick direction or type)
            // Fallback to type
            isBuy = (trade.type === 1);
        }
    } else {
        // No quote context? Use type
        isBuy = (trade.type === 1);
    }

    // Update Delta & Profile
    const priceStr = trade.price.toString(); // Map key string
    if (!c.profile[priceStr]) c.profile[priceStr] = { bid: 0, ask: 0 };

    if (isBuy) {
        c.delta += trade.volume;
        c.profile[priceStr].ask += trade.volume;
    } else {
        c.delta -= trade.volume;
        c.profile[priceStr].bid += trade.volume;
    }
}

function finalizeCandle(c) {
    // 1. Find POC
    let maxVol = -1;
    let pocPrice = 0;

    // 2. Convert profile map to array levels: [price, bid_vol, ask_vol]
    const levels = [];

    // Sort prices
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

    // Cleanup temporary fields
    delete c.profile;
    delete c.time;
}

processFile();
