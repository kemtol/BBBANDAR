// Node 18+ has built-in fetch


// If node-fetch is not available, we can rely on Node 18+ global fetch or standard https
// To be safe, let's use standard https if fetch isn't global, but concise code prefers fetch.
// let's try to assume global fetch (Node 18+) or provide a simple https wrapper.

const API_BASE = 'https://fut-state-engine.mkemalw.workers.dev/data';
const SYMBOL = 'ENQ';
const TF = '1m';

async function main() {
    console.log("Starting Footprint Data Verification...");

    // Check last 3 hours
    const now = new Date();
    let totalCandles = 0;
    let validCandles = 0;
    let invalidCandles = 0;

    for (let i = 0; i < 3; i++) {
        const t = new Date(now.getTime() - (i * 60 * 60 * 1000));
        const y = t.getUTCFullYear();
        const m = String(t.getUTCMonth() + 1).padStart(2, '0');
        const d = String(t.getUTCDate()).padStart(2, '0');
        const h = String(t.getUTCHours()).padStart(2, '0');

        const url = `${API_BASE}/${y}/${m}/${d}/${h}`;
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
                const c = JSON.parse(line);
                const issues = validateCandle(c);

                if (issues.length === 0) {
                    validCandles++;
                } else {
                    invalidCandles++;
                    console.error(`  [FAIL] Candle ${c.t0}: ${issues.join(', ')}`);
                }
            }
        } catch (e) {
            console.error(`  -> Error fetching: ${e.message}`);
        }
    }

    console.log("\nReconciliation Summary:");
    console.log(`Checked: ${totalCandles} candles`);
    console.log(`Valid:   ${validCandles}`);
    console.log(`Invalid: ${invalidCandles}`);

    if (invalidCandles === 0 && totalCandles > 0) {
        console.log("\n✅ DATA INTEGRITY VERIFIED (Calculations match)");
    } else if (totalCandles === 0) {
        console.log("\n⚠️ NO DATA FOUND TO VERIFY");
    } else {
        console.log("\n❌ DATA INTEGRITY ERRORS FOUND");
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
            sumBid += l.bv;
            sumAsk += l.av;

            // Level Delta Check
            const diff = l.av - l.bv;
            // Floating point tolerance
            if (Math.abs(diff - l.d) > 0.0001) {
                issues.push(`Level Price ${l.p} delta mismatch (calc ${diff} vs rec ${l.d})`);
            }
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

// Minimal polyfill for fetch if needed (Node < 18)
if (typeof fetch === "undefined") {
    console.error("This script requires Node 18+ or a fetch polyfill.");
    process.exit(1);
}

main();
