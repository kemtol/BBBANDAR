const puppeteer = require('puppeteer');

(async () => {
    const TARGET_URL = 'https://indopremier.com/#ipot/app/marketlive';

    // Get Worker URL from env (set in GitHub Secrets)
    const WORKER_URL = process.env.WORKER_URL; // e.g., https://livetrade-taping.mkemalw.workers.dev
    if (!WORKER_URL) {
        console.error("❌ Stats: Missing WORKER_URL env var");
        process.exit(1);
    }

    // --- PRE-CHECK: Is Worker already happy? ---
    try {
        console.log(`🔍 Checking Worker Status at ${WORKER_URL}...`);
        // Node 18+ has native fetch. If on older node, might need axios, but GHA setup uses '18'.
        const statusReq = await fetch(WORKER_URL);
        if (statusReq.ok) {
            const data = await statusReq.json();
            console.log("📊 Current Status:", JSON.stringify(data, null, 2));

            if (data.status && data.status.includes("CONNECTED")) {
                console.log("✅ Worker is CONNECTED. Token still valid. Exiting.");
                process.exit(0);
            }
            console.log("⚠️ Worker not connected. Refreshing token...");
        }
    } catch (e) {
        console.warn("⚠️ Health check failed (network?), proceeding to refresh:", e.message);
    }
    // -------------------------------------------

    console.log("🚀 Launching Browser...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Enable request interception
    await page.setRequestInterception(true);

    let tokenFound = null;

    page.on('request', request => {
        const url = request.url();
        // Look for WebSocket connection with appsession
        if (url.includes('socketcluster') && url.includes('appsession=')) {
            const match = url.match(/appsession=([^&]+)/);
            if (match && match[1]) {
                tokenFound = match[1];
                console.log("✅ Token Found:", tokenFound);
            }
        }
        request.continue();
    });

    console.log(`🌍 Navigating to ${TARGET_URL}...`);
    try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait a bit more for WS to connect if not already
        if (!tokenFound) {
            console.log("⏳ Waiting for WebSocket...");
            await new Promise(r => setTimeout(r, 5000));
        }

        if (tokenFound) {
            console.log(`📤 Sending token to Worker: ${WORKER_URL}...`);
            const updateUrl = `${WORKER_URL}/update?token=${tokenFound}`;

            // Use fetch from node (requires node 18+) or axios. 
            // Since we are in GHA, we can use built-in fetch.
            try {
                const resp = await fetch(updateUrl);
                const text = await resp.text();
                console.log("Worker Response:", text);
            } catch (e) {
                console.error("❌ Failed to push token to worker:", e.message);
                process.exit(1);
            }

        } else {
            console.error("❌ Token NOT found after loading page.");
            process.exit(1);
        }

    } catch (e) {
        console.error("❌ Error during navigation:", e);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
