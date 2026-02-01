const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8790';
const OUT_DIR = 'test_output';

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ data, statusCode: res.statusCode }));
        }).on('error', reject);
    });
}

async function run() {
    console.log("--- SIMULATION: SCRAPE & SAVE TO TEST_OUTPUT (Jan 19-22) ---");

    const symbol = 'TLKM';
    const dates = ['2026-01-19', '2026-01-20', '2026-01-21'];

    // 1. Trigger Batch Scrape (Save to R2)
    const scrapeUrl = `${BASE}/ipot/scrape?symbol=${symbol}&from=2026-01-19&to=2026-01-21&save=true&debug=true`;
    console.log(`\n1. Triggering Scrape: ${scrapeUrl}`);
    const scrapeRes = await get(scrapeUrl);

    try {
        const j = JSON.parse(scrapeRes.data);
        console.log(`   Message: ${j.message}`);
        // Check for new wrapper
        if (!j.data || !j.data.mode) {
            console.error("FAIL: Missing j.data.mode or j.data (Check structure)");
            console.log("Raw:", JSON.stringify(j).slice(0, 200));
        } else {
            console.log(`   Mode: ${j.data.mode}`);
            console.log(`   Count: ${j.data.count}`);
        }
    } catch (e) {
        console.error("   Failed to parse scrape response:", scrapeRes.data);
        return;
    }

    // 2. Retrieve from R2 and Save to test_output
    console.log(`\n2. Retrieving files from R2 and saving to ${OUT_DIR}...`);

    for (const date of dates) {
        const readUrl = `${BASE}/read-broksum?symbol=${symbol}&date=${date}`;
        console.log(`   Fetching ${date} from ${readUrl}...`);

        const readRes = await get(readUrl);

        if (readRes.statusCode !== 200) {
            console.error(`   FAILED to read ${date}: Status ${readRes.statusCode}`);
            continue;
        }

        const outPath = path.join(OUT_DIR, symbol, `${date}.json`);
        // Ensure dir exists
        fs.mkdirSync(path.dirname(outPath), { recursive: true });

        fs.writeFileSync(outPath, readRes.data);
        console.log(`   Saved to ${outPath}`);

        // Verify structure of one file
        if (date === dates[0]) {
            const f = JSON.parse(readRes.data);
            console.log("\n   [VERIFY JSON STRUCTURE (Jan 19)]");
            console.log(`   Wrapper Message: ${f.message}`);
            console.log(`   Data.From: ${f.data?.from}`);
            console.log(`   Bandar Detector Present: ${!!f.data?.bandar_detector}`);
            if (f.data?.bandar_detector) {
                console.log(`     AccDist: ${f.data.bandar_detector.accdist}`);
                console.log(`     Top1 Bid Val: ${f.data.bandar_detector.top1?.bid_val}`);
                console.log(`     Total Buyers: ${f.data.bandar_detector.total_buyer}`);
            }
            console.log(`   Broker Summary Symbol: ${f.data?.broker_summary?.symbol}`);
            console.log(`   Broker Type Example: ${f.data?.broker_summary?.brokers_buy[0]?.type}`);
            console.log(`   Stock Summary Hidden: ${!f.data?.broker_summary?.stock_summary}`);
        }
    }

    console.log("\nDone.");
}

run();
