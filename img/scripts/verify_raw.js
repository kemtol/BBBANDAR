const API_BASE = 'https://fut-state-engine.mkemalw.workers.dev';
const SYMBOL = 'ENQ';
const TF = '1m';

async function main() {
    console.log("Starting RAW vs FOOTPRINT Replay Verification...");

    const now = new Date();
    // Check previous hour to ensure full data
    const t = new Date(now.getTime() - 60 * 60 * 1000);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    const h = String(t.getUTCHours()).padStart(2, '0');

    console.log(`Target Hour: ${y}-${m}-${d} ${h}:00 UTC`);

    // 1. Fetch Footprint Data
    console.log("\n1. Fetching Footprint Data...");
    const fpUrl = `${API_BASE}/data/${y}/${m}/${d}/${h}`;
    let footprintCandles = [];
    try {
        const res = await fetch(fpUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const text = await res.text();
        footprintCandles = text.split('\n').filter(Boolean).map(JSON.parse);
        console.log(`   -> Loaded ${footprintCandles.length} footprint candles`);
    } catch (e) {
        console.error("   -> Failed to load footprint:", e.message);
        return;
    }

    if (footprintCandles.length === 0) return;

    // 2. Fetch All Raw Minutes
    console.log("\n2. Fetching Raw Data (60 minutes)...");
    let allTrades = [];
    let bestBid = 0;
    let bestAsk = 0;
    const seenTrades = new Set();

    for (let mm = 0; mm < 60; mm++) {
        const mmStr = String(mm).padStart(2, '0');
        const rawUrl = `${API_BASE}/raw/${y}/${m}/${d}/${h}/${mmStr}`;

        try {
            const res = await fetch(rawUrl);
            if (!res.ok) {
                // process.stdout.write('.');
                continue;
            }
            const text = await res.text();
            const lines = text.split('\n').filter(Boolean);

            // Process frames similar to worker
            for (const line of lines) {
                // Frame format is stringified JSON. sometimes wrapped? 
                // The worker buffers `String(data)` which is signalR frame.
                // SignalR frames are delimited by \u001e (record separator) if multiple
                // But the backup is "bufferRawFrame" which pushes individual frames

                // Let's parse potential SignalR envelope
                const frames = line.split('\u001e').filter(Boolean);

                for (const f of frames) {
                    let msg;
                    try { msg = JSON.parse(f); } catch { continue; }

                    // Quote
                    if (msg.target === "RealTimeSymbolQuote" && msg.arguments?.[0]) {
                        const q = msg.arguments[0];
                        const sym = String(q.symbol || "").replace("F.US.", "");
                        if (sym === SYMBOL) {
                            if (Number.isFinite(q.bestBid)) bestBid = q.bestBid;
                            if (Number.isFinite(q.bestAsk)) bestAsk = q.bestAsk;
                        }
                    }

                    // Trade
                    if (msg.target === "RealTimeTradeLogWithSpeed") {
                        const symRaw = msg.arguments?.[0];
                        const trades = msg.arguments?.[1];
                        const sym = String(symRaw || "").replace("F.US.", "");
                        if (sym !== SYMBOL) continue;
                        if (!Array.isArray(trades)) continue;

                        for (const trade of trades) {
                            const ts = new Date(trade.timestamp).getTime();
                            if (!Number.isFinite(ts)) continue;

                            // Replicate Aggressor Logic
                            const tick = 0.25;
                            const eps = tick / 2;
                            const px = trade.price;

                            // DEDUP LOGIC (Match Worker)
                            // Worker: const dedupKey = `${trade.timestamp}|${trade.price}|${trade.volume}|${trade.type}`;
                            const dedupKey = `${trade.timestamp}|${trade.price}|${trade.volume}|${trade.type}`;
                            if (seenTrades.has(dedupKey)) continue;
                            seenTrades.add(dedupKey);

                            let isBuy;         // Naive replay: usage of "current" bestBid/bestAsk derived from *processed order*
                            // NOTE: This won't be 100% perfect as worker state updates in real-time order 
                            // interspersed with trades. But raw log should have them in approx order.
                            if (bestBid > 0 && bestAsk > 0) {
                                if (px >= (bestAsk - eps)) isBuy = true;
                                else if (px <= (bestBid + eps)) isBuy = false;
                                else isBuy = (trade.type === 0);
                            } else {
                                isBuy = (trade.type === 0);
                            }

                            allTrades.push({
                                ts,
                                price: px,
                                vol: trade.volume,
                                isBuy
                            });
                        }
                    }
                }
            }
        } catch (e) {
            // failed minute
        }
    }
    console.log(`\n   -> Replayed ${allTrades.length} individual trades`);

    // 3. Aggregate trades into buckets
    console.log("\n3. Aggregating Replayed Data...");
    const buckets = new Map(); // bucketTs -> { vol, delta }

    for (const t of allTrades) {
        const bucketTs = Math.floor(t.ts / 60000) * 60000;
        if (!buckets.has(bucketTs)) buckets.set(bucketTs, { vol: 0, delta: 0, count: 0 });

        const b = buckets.get(bucketTs);
        b.vol += t.vol;
        b.delta += (t.isBuy ? t.vol : -t.vol);
        b.count++;
    }

    // 4. Compare
    console.log("\n4. Comparison Report (Footprint vs Replay)");
    console.log("----------------------------------------------------------------");
    console.log(
        "Time".padEnd(20) +
        "FP Vol".padStart(10) + "Raw Vol".padStart(10) + "Diff".padStart(8) + " | " +
        "FP Dlt".padStart(10) + "Raw Dlt".padStart(10) + "Diff".padStart(8)
    );
    console.log("----------------------------------------------------------------");

    let matchCount = 0;
    let mismatchCount = 0;

    for (const candle of footprintCandles) {
        const ts = new Date(candle.t0).getTime();
        const timeStr = new Date(ts).toISOString().slice(11, 16);

        const replayed = buckets.get(ts);

        if (!replayed) {
            console.log(`${timeStr.padEnd(20)} [MISSING IN RAW]`);
            continue;
        }

        const volDiff = candle.vol - replayed.vol;
        const deltaDiff = candle.delta - replayed.delta;

        const isMatch = Math.abs(volDiff) < 0.001 && Math.abs(deltaDiff) < 0.001;
        if (isMatch) matchCount++;
        else mismatchCount++;

        console.log(
            `${timeStr.padEnd(20)}` +
            `${candle.vol.toFixed(0)}`.padStart(10) +
            `${replayed.vol.toFixed(0)}`.padStart(10) +
            `${volDiff.toFixed(0)}`.padStart(8) +
            " | " +
            `${candle.delta.toFixed(0)}`.padStart(10) +
            `${replayed.delta.toFixed(0)}`.padStart(10) +
            `${deltaDiff.toFixed(0)}`.padStart(8)
        );
    }
    console.log("----------------------------------------------------------------");
    console.log(`Exact Matches: ${matchCount}`);
    console.log(`Mismatches:    ${mismatchCount}`);

    if (mismatchCount === 0) {
        console.log("\n✅ PERFECT MATCH: Raw trades aggregate exactly to Footprint.");
    } else {
        console.log("\n⚠️ MISMATCH DETECTED: Slight differences in aggressor logic or timing?");
        console.log("   (Note: small delta differences are expected due to 'best bid/ask' timing drift in replay)");
    }
}

// Node 18+ check
if (typeof fetch === "undefined") {
    console.error("Node 18+ required");
    process.exit(1);
}

main();
