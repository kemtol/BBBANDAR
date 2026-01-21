
// const fetch = require('node-fetch'); // Using global fetch

const AGG_BASE = "https://livetrade-taping-agregator.mkemalw.workers.dev";
const ENGINE_BASE = "https://livetrade-durable-object.mkemalw.workers.dev";
const TARGET_TICKER = "BBCA"; // Safe bet for Indonesian market

const DATES = [
    "2026-01-15", "2026-01-14", "2026-01-13", "2026-01-12",
    "2026-01-11", "2026-01-10", "2026-01-09", "2026-01-08"
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log("🚀 STARTING HOLISTIC TRIGGER & MONITOR (Jan 08 - Jan 15)");

    // 1. Trigger
    console.log("\n[1/3] Triggering Batch Job...");
    const triggerUrl = `${AGG_BASE}/admin/seed-day?date=2026-01-15&days=8`;
    try {
        const res = await fetch(triggerUrl, { method: 'POST' });
        const json = await res.json();
        console.log("Trigger Result:", json);
    } catch (e) {
        console.error("Trigger Failed:", e);
        process.exit(1);
    }

    // 2. Poll Status
    console.log("\n[2/3] Polling Status...");
    let allDone = false;
    while (!allDone) {
        let pending = 0;
        let completed = 0;
        let failed = 0;
        const stati = {};

        for (const date of DATES) {
            try {
                const res = await fetch(`${AGG_BASE}/debug-r2?key=seed_status/${date}.json`);
                const json = await res.json();
                stati[date] = json.status || 'UNKNOWN';

                if (json.status === 'COMPLETED') completed++;
                else if (json.status === 'FAILED') failed++;
                else pending++;
            } catch (e) {
                // assume pending/missing
                pending++;
            }
        }

        console.log(`Status Update: COMPLETED=${completed}, FAILED=${failed}, PROCESSING=${pending}`);

        if (pending === 0) {
            allDone = true;
            console.log("Detailed Status:", stati);
        } else {
            await sleep(5000);
        }
    }

    // 3. Verify Content (Sampling)
    console.log("\n[3/3] Verifying Content for Ticker:", TARGET_TICKER);

    // Check Processed Intraday
    console.log(`Checking Processed Intraday (${TARGET_TICKER})...`);
    try {
        const res = await fetch(`${AGG_BASE}/debug-r2?key=processed/${TARGET_TICKER}/intraday.json`);
        if (res.status === 200) {
            const json = await res.json();
            const len = json.timeline ? json.timeline.length : 0;
            console.log(`✅ ${TARGET_TICKER} Intraday JSON exists. Timeline Length: ${len}`);
        } else {
            console.error(`❌ ${TARGET_TICKER} Intraday JSON NOT FOUND (${res.status})`);
        }
    } catch (e) { console.error("Error checking intraday", e); }

    // Check Footprint Sample (Jan 8 & Jan 15)
    for (const date of ["2026-01-08", "2026-01-15"]) {
        const [y, m, d] = date.split('-');
        // Check hour 03 (UTC) approx 10:00 WIB
        const h = "03";
        const url = `${ENGINE_BASE}/debug/hour?ticker=${TARGET_TICKER}&y=${y}&m=${m}&d=${d}&h=${h}`;
        console.log(`Checking Footprint ${date} Hour ${h}...`);
        try {
            const res = await fetch(url);
            const json = await res.json();
            if (json.linesCount > 0) {
                console.log(`✅ Footprint ${date} OK: ${json.linesCount} candles.`);
            } else {
                console.warn(`⚠️ Footprint ${date} Warning: Method returned 0 lines (Might be empty hour or file missing). Response:`, json);
            }
        } catch (e) { console.error(`Error checking footprint ${date}`, e); }
    }

    console.log("\n✨ MONITORING COMPLETE");
}

main();
