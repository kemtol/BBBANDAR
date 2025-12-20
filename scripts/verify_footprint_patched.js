// Node 18+ has built-in fetch

const API_BASE = 'https://fut-state-engine.mkemalw.workers.dev/data';
const SYMBOL = 'ENQ';
const TF = '1m';

async function main() {
    console.log("Starting Footprint Data Verification (2025-12-19)...\n");

    // Check data for Dec 19, 2025 (the date we patched)
    const date = new Date('2025-12-19T00:00:00Z');
    let totalCandles = 0;
    let validCandles = 0;
    let invalidCandles = 0;
    let ladderGaps = 0;
    let ladderContinuous = 0;

    // Check hours 08-18 (market hours)
    for (let h = 8; h <= 18; h++) {
        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        const hStr = String(h).padStart(2, '0');

        const url = `${API_BASE}/${y}/${m}/${d}/${hStr}`;
        console.log(`Checking ${url}...`);

        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.log(`  -> No data (Status ${res.status})`);
                continue;
            }

            const text = await res.text();
            const lines = text.split('\n').filter(l => l.trim());

            for (const line of lines) {
                totalCandles++;
                try {
                    const c = JSON.parse(line);
                    const issues = validateCandle(c);

                    if (issues.length === 0) {
                        validCandles++;
                    } else {
                        invalidCandles++;
                        console.error(`  [FAIL] Candle ${c.t0}: ${issues.join(', ')}`);
                    }

                    // Check ladder continuity
                    const ladderResult = checkLadderContinuity(c);
                    if (ladderResult.continuous) {
                        ladderContinuous++;
                    } else {
                        ladderGaps++;
                        if (ladderGaps <= 3) {  // Only show first 3
                            console.log(`  [GAP] ${c.t0}: ${ladderResult.gaps} gaps found`);
                        }
                    }
                } catch (e) {
                    invalidCandles++;
                    console.error(`  [PARSE ERROR] ${e.message}`);
                }
            }
        } catch (e) {
            console.error(`  -> Error fetching: ${e.message}`);
        }
    }

    console.log("\n=== RECONCILIATION SUMMARY ===");
    console.log(`Checked: ${totalCandles} candles`);
    console.log(`Valid (delta/vol):  ${validCandles}`);
    console.log(`Invalid: ${invalidCandles}`);
    console.log("");
    console.log("=== LADDER CONTINUITY ===");
    console.log(`Continuous: ${ladderContinuous}`);
    console.log(`With Gaps:  ${ladderGaps}`);

    if (invalidCandles === 0 && totalCandles > 0) {
        console.log("\n✅ DATA INTEGRITY VERIFIED");
    } else if (totalCandles === 0) {
        console.log("\n⚠️ NO DATA FOUND TO VERIFY");
    } else {
        console.log("\n❌ DATA INTEGRITY ERRORS FOUND");
    }

    if (ladderGaps === 0 && totalCandles > 0) {
        console.log("✅ LADDER CONTINUITY VERIFIED (No gaps)");
    } else if (ladderGaps > 0) {
        console.log(`❌ LADDER GAPS FOUND (${ladderGaps} candles with gaps)`);
    }
}

function validateCandle(c) {
    const issues = [];

    // 1. Server-side reported error
    if (c.integrity_error) {
        issues.push(`Server reported: ${c.integrity_error}`);
    }

    // 2. Client-side Checksum
    let sumBid = 0;
    let sumAsk = 0;

    if (c.levels && Array.isArray(c.levels)) {
        for (const l of c.levels) {
            // Handle both formats: {bv, av} or [p, bid, ask]
            const bid = l.bv !== undefined ? l.bv : l[1];
            const ask = l.av !== undefined ? l.av : l[2];
            sumBid += bid || 0;
            sumAsk += ask || 0;
        }
    }

    const totalVol = sumBid + sumAsk;
    const totalDelta = sumAsk - sumBid;

    // Volume Check
    if (Math.abs(totalVol - c.vol) > 0.0001) {
        issues.push(`Volume Mismatch (Levels Sum ${totalVol} vs Header ${c.vol})`);
    }

    // Delta Check
    if (Math.abs(totalDelta - c.delta) > 0.0001) {
        issues.push(`Delta Mismatch (Levels Sum ${totalDelta} vs Header ${c.delta})`);
    }

    return issues;
}

function checkLadderContinuity(c) {
    if (!c.levels || !Array.isArray(c.levels) || c.levels.length < 2) {
        return { continuous: true, gaps: 0 };
    }

    const tick = c.tick || 0.25;
    let gaps = 0;

    for (let i = 0; i < c.levels.length - 1; i++) {
        const currentPrice = c.levels[i].p !== undefined ? c.levels[i].p : c.levels[i][0];
        const nextPrice = c.levels[i + 1].p !== undefined ? c.levels[i + 1].p : c.levels[i + 1][0];

        const expectedDiff = tick;
        const actualDiff = Math.abs(currentPrice - nextPrice);

        // Allow small float tolerance
        if (Math.abs(actualDiff - expectedDiff) > 0.01) {
            gaps++;
        }
    }

    return { continuous: gaps === 0, gaps };
}

// Minimal polyfill for fetch if needed (Node < 18)
if (typeof fetch === "undefined") {
    console.error("This script requires Node 18+ or a fetch polyfill.");
    process.exit(1);
}

main();
