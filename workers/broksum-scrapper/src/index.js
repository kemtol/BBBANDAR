// Helper: Get token from KV
const HARDCODED_TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjU3MDc0NjI3LTg4MWItNDQzZC04OTcyLTdmMmMzOTNlMzYyOSIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7InVzZSI6ImtlbXRvbCIsImVtYSI6Im1rZW1hbHdAZ21haWwuY29tIiwiZnVsIjoiTXVzdGFmYSBLZW1hbCBXaXJ5YXdhbiIsInNlcyI6IiIsImR2YyI6IjVjZjJmZjljM2JkMjFhYzFmYmZhNTZiNGE1MjE4YWJhIiwiZGlkIjoiZGVza3RvcCIsInVpZCI6MjMwNTM1MCwiY291IjoiSUQifSwiZXhwIjoxNzY4Mjg1MDI5LCJpYXQiOjE3NjgxOTg2MjksImlzcyI6IlNUT0NLQklUIiwianRpIjoiNjBlNDI2Y2QtODVhMi00ZDU2LTg3YjktZWM1OGQ0NDg4ZWNhIiwibmJmIjoxNzY4MTk4NjI5LCJ2ZXIiOiJ2MSJ9.Rs9nGH-5OvxzbGiPaNzZ3Ye_uXWq9z__d8sjSi06kGxpmi_hbQ_f76gL29XTzc5IwtsytmWjOGX4kZAPNhxofEIsD9hFRNjlEUyQ4gY6IyenkIJKJcnI-V8XBDW2iGrgVUENy6cApqCUKZzmnz3l0oIuPkk8RjTVUa9gTt3461-GrKzcUUMLBG24kwyLcLBu9U1pvP_1XRSVFs64BjCqMW7_RvEDDlnscYNYEKnPltKLnDK0S-OFPx5vrG6lCb62trOgRXd188LqgiDqKSFgPC8HtWx-tVvBCqhJWqlmJTmfs1U6GMFn6VaCjE4WK_L3_iZxTsrZmiA5aMHpwPCULw";

async function getToken(env) {
    if (HARDCODED_TOKEN) return HARDCODED_TOKEN;

    const stored = await env.SSSAHAM_WATCHLIST.get("STOCKBIT_TOKEN");
    if (!stored) {
        throw new Error("No token found in KV. Please update token via rpa-auth.");
    }
    const data = JSON.parse(stored);
    return data.access_token;
}

// Helper: Check if R2 object exists
async function objectExists(env, key) {
    try {
        const head = await env.RAW_BROKSUM.head(key);
        return head !== null;
    } catch (e) {
        return false;
    }
}

// Helper: Get trading days (skip weekends) for last N days
function getTradingDays(days, startDate = new Date()) {
    const dates = [];
    const start = new Date(startDate);
    let count = 0;
    let offset = 1; // Start from yesterday

    while (count < days) {
        const date = new Date(start);
        date.setDate(start.getDate() - offset);
        const dayOfWeek = date.getDay();

        // Skip weekends (0 = Sunday, 6 = Saturday)
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            dates.push(date.toISOString().split("T")[0]);
            count++;
        }
        offset++;
    }
    return dates;
}

// Helper: Add CORS headers
function withCors(headers = {}) {
    return {
        ...headers,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}

// SMART MONEY ENGINE (Ported to Backend)
class SmartMoney {
    constructor() {
        this.W1 = 1.0; // Effort
        this.W2 = 1.0; // Result (negative impact)
        this.W3 = 1.0; // Elasticity
        this.W4 = 0.5; // NGR
    }

    static stdDev(array, mean) {
        if (array.length === 0) return 0;
        return Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / array.length);
    }

    analyze(history) {
        if (!history || history.length < 20) return null;

        // Sort by date ascending
        const data = [...history].sort((a, b) => new Date(a.date) - new Date(b.date));
        const n = data.length;
        const window = 20;

        // 1. Calculate base metrics
        const metrics = data.map((d, i) => {
            // Price Return (using close price if available, else 0)
            let ret = 0;
            const currClose = d.close || (d.data && d.data.close) || 0;
            const prevClose = i > 0 ? (data[i - 1].close || (data[i - 1].data && data[i - 1].data.close) || 0) : 0;

            if (prevClose > 0 && currClose > 0) {
                ret = (currClose - prevClose) / prevClose;
            }

            // Gross & Net from Broker Summary
            const foreign = d.data?.foreign || { buy_val: 0, sell_val: 0 };
            const retail = d.data?.retail || { buy_val: 0, sell_val: 0 };
            const local = d.data?.local || { buy_val: 0, sell_val: 0 };

            const grossBuy = foreign.buy_val + retail.buy_val + local.buy_val;
            const grossSell = foreign.sell_val + retail.sell_val + local.sell_val;

            const effort = grossBuy + grossSell;
            const net = grossBuy - grossSell;
            const result = Math.abs(ret);

            return { date: d.date, effort, result, net, ret };
        });

        // 2. Rolling Z-Scores (Latest)
        const lastIdx = n - 1;
        const latest = metrics[lastIdx];
        const slice = metrics.slice(Math.max(0, n - window), n);

        const effortMean = slice.reduce((a, b) => a + b.effort, 0) / slice.length;
        const effortStd = SmartMoney.stdDev(slice.map(s => s.effort), effortMean);
        const effortZ = effortStd === 0 ? 0 : (latest.effort - effortMean) / effortStd;

        const resultMean = slice.reduce((a, b) => a + b.result, 0) / slice.length;
        const resultStd = SmartMoney.stdDev(slice.map(s => s.result), resultMean);
        const resultZ = resultStd === 0 ? 0 : (latest.result - resultMean) / resultStd;

        const ngr = latest.effort === 0 ? 0 : Math.abs(latest.net) / latest.effort;
        const epsilon = 1e-9;
        const elasticity = latest.result / (Math.abs(latest.net) + epsilon);

        // Rolling metrics for trend
        const prevEffortZ = n > 1 ? ((metrics[n - 2].effort - effortMean) / effortStd) : 0;
        const effortDeclining = effortZ < prevEffortZ;

        const sliceElas = slice.map(s => s.result / (Math.abs(s.net) + epsilon));
        const elasMean = sliceElas.reduce((a, b) => a + b, 0) / sliceElas.length;
        const elasStd = SmartMoney.stdDev(sliceElas, elasMean);
        const elasZ = elasStd === 0 ? 0 : (elasticity - elasMean) / elasStd;

        const sliceNGR = slice.map(s => s.effort === 0 ? 0 : Math.abs(s.net) / s.effort);
        const ngrMean = sliceNGR.reduce((a, b) => a + b, 0) / sliceNGR.length;
        const ngrStd = SmartMoney.stdDev(sliceNGR, ngrMean);
        const ngrZ = ngrStd === 0 ? 0 : (ngr - ngrMean) / ngrStd;

        // 3. Classification
        let state = 'NEUTRAL';
        const isEffortHigh = effortZ > 0.5;
        const isEffortLow = effortZ < -0.5;
        const isResultLow = resultZ < 0;

        if (effortDeclining && resultZ > -0.5 && elasticity > elasMean * 1.1) {
            state = 'READY_MARKUP';
        } else if (isEffortHigh && Math.abs(resultZ) < 0.5) {
            state = 'TRANSITION';
        } else if (isEffortHigh && resultZ < -0.5 && latest.ret >= 0) {
            state = 'ACCUMULATION';
        } else if (isEffortHigh && latest.ret < -0.01) {
            state = 'DISTRIBUTION';
        }

        if (state === 'NEUTRAL' && isEffortLow && isResultLow) state = 'NEUTRAL';

        // 4. Score
        const score = (this.W1 * effortZ) - (this.W2 * Math.abs(resultZ)) + (this.W3 * (1 - elasZ)) + (this.W4 * ngrZ);

        return {
            state,
            score,
            metrics: {
                effortZ, resultZ, elasticity, ngr, ret: latest.ret
            }
        };
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS Helper
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // NEW ROUTE: Get Screener Results
            if (path === "/screener") {
                const results = await env.SSSAHAM_WATCHLIST.get("SCREENER_RESULT", { type: "json" });
                return new Response(JSON.stringify(results || { candidates: [] }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            // NEW ROUTE: Trigger Screener Run (Manual)
            if (path === "/trigger-screener") {
                ctx.waitUntil(this.runScreener(env));
                return new Response(JSON.stringify({ message: "Screener triggered in background" }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            // ... Existing Routes ...
            // ROUTE 1: Update Watchlist (Fetch from Templates -> Save to KV)
            if (path === "/update-watchlist") {
                return await this.updateWatchlist(env);
            }

            // ROUTE 2: Trigger Scraping for single date (Read KV -> Dispatch to Queue)
            if (path === "/scrape") {
                let date = url.searchParams.get("date");
                const overwrite = url.searchParams.get("overwrite") === "true";
                if (!date) {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    date = yesterday.toISOString().split("T")[0];
                }
                return await this.dispatchScrapeJobs(env, date, overwrite);
            }

            // ROUTE 3: Backfill N days (default 90)
            if (path === "/backfill-queue") {
                const days = parseInt(url.searchParams.get("days") || "90");
                const overwrite = url.searchParams.get("overwrite") === "true";
                return await this.backfill90Days(env, days, overwrite);
            }

            // ROUTE 4: Trigger full flow (update watchlist + backfill)
            if (path === "/trigger-full-flow") {
                const days = parseInt(url.searchParams.get("days") || "90");
                const overwrite = url.searchParams.get("overwrite") === "true";

                // 1. Update watchlist first
                const watchlistResult = await this.updateWatchlist(env);
                const watchlistData = await watchlistResult.json();

                // 2. Then backfill
                const backfillResult = await this.backfill90Days(env, days, overwrite);
                const backfillData = await backfillResult.json();

                return new Response(JSON.stringify({
                    message: "Full flow triggered",
                    watchlist: watchlistData,
                    backfill: backfillData
                }), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // ROUTE 4.5: Init Backfill (All Active Emiten from D1)
            if (path === "/init") {
                const days = parseInt(url.searchParams.get("days") || "5"); // Default safe limit
                const overwrite = url.searchParams.get("overwrite") === "true";
                const fromDate = url.searchParams.get("from"); // Optional start date
                return await this.backfillActiveEmiten(env, days, overwrite, fromDate);
            }

            // ROUTE 4.6: Automated Backfill Control (Cursor Based)
            if (path === "/backfill/status") {
                const cursor = await env.SSSAHAM_WATCHLIST.get("BACKFILL_CURSOR") || "0";
                const active = await env.SSSAHAM_WATCHLIST.get("BACKFILL_ACTIVE") || "false";
                return new Response(JSON.stringify({ cursor: parseInt(cursor), active: active === "true" }), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            if (path === "/backfill/resume") {
                await env.SSSAHAM_WATCHLIST.put("BACKFILL_ACTIVE", "true");
                // Optionally trigger one batch immediately
                const result = await this.processNextBackfillBatch(env);
                return new Response(JSON.stringify({ message: "Backfill Resumed", result }), { headers: { "Content-Type": "application/json" } });
            }

            if (path === "/backfill/pause") {
                await env.SSSAHAM_WATCHLIST.put("BACKFILL_ACTIVE", "false");
                return new Response(JSON.stringify({ message: "Backfill Paused" }), { headers: { "Content-Type": "application/json" } });
            }

            if (path === "/backfill/reset") {
                await env.SSSAHAM_WATCHLIST.put("BACKFILL_CURSOR", "0");
                return new Response(JSON.stringify({ message: "Cursor Reset to 0" }), { headers: { "Content-Type": "application/json" } });
            }

            // ROUTE 5: Debug token - test API with stored token
            if (path === "/debug-token") {
                try {
                    const TOKEN = await getToken(env);
                    const symbol = url.searchParams.get("symbol") || "BBCA";
                    const dateParam = url.searchParams.get("date");
                    const date = dateParam || new Date().toISOString().split('T')[0];

                    const targetUrl = `https://exodus.stockbit.com/marketdetectors/${symbol}?from=${date}&to=${date}&transaction_type=TRANSACTION_TYPE_GROSS&market_board=MARKET_BOARD_REGULER&investor_type=INVESTOR_TYPE_ALL&limit=25`;

                    const response = await fetch(targetUrl, {
                        method: "GET",
                        headers: {
                            "Host": "exodus.stockbit.com",
                            "Connection": "keep-alive",
                            "X-Platform": "desktop",
                            "Authorization": `Bearer ${TOKEN}`,
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                            "Accept": "application/json, text/plain, */*",
                            "Origin": "https://tauri.localhost",
                            "Referer": "https://tauri.localhost/",
                            "Sec-Fetch-Site": "cross-site",
                            "Sec-Fetch-Mode": "cors",
                            "Sec-Fetch-Dest": "empty",
                            "sec-ch-ua-platform": '"Windows"',
                            "sec-ch-ua-mobile": "?0",
                            "Accept-Encoding": "gzip, deflate, br"
                        }
                    });

                    const data = await response.json();

                    return new Response(JSON.stringify({
                        token_preview: TOKEN.substring(0, 50) + "...",
                        token_length: TOKEN.length,
                        api_status: response.status,
                        api_response: data
                    }), {
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message }), {
                        status: 500,
                        headers: { "Content-Type": "application/json" }
                    });
                }
            }

            // ROUTE 6: Read Watchlist (for frontend index)
            if (path === "/watchlist") {
                const watchlistData = await env.SSSAHAM_WATCHLIST.get("LATEST", { type: "json" });
                return new Response(JSON.stringify(watchlistData), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }

            // ROUTE 7: Read Broksum (Single Date)
            if (path === "/read-broksum") {
                const symbol = url.searchParams.get("symbol");
                const date = url.searchParams.get("date");
                if (!symbol || !date) return new Response("Missing symbol or date", { status: 400, headers: withCors() });

                const key = `${symbol}/${date}.json`;
                const object = await env.RAW_BROKSUM.get(key);

                if (!object) return new Response("Not found", { status: 404, headers: withCors() });

                const headers = new Headers(object.httpMetadata);
                object.writeHttpMetadata(headers);
                headers.set("etag", object.httpEtag);

                return new Response(object.body, { headers: withCors(Object.fromEntries(headers)) });
            }

            // ROUTE 8: Read Broksum (Range)
            // Limit to avoid timeout: max 30 days per call recommended
            if (path === "/read-broksum-range") {
                const symbol = url.searchParams.get("symbol");
                const from = url.searchParams.get("from");
                const to = url.searchParams.get("to");

                if (!symbol || !from || !to) return new Response("Missing symbol, from, or to", { status: 400, headers: withCors() });

                // Simple date loop
                const startDate = new Date(from);
                const endDate = new Date(to);
                const results = [];
                const accBrokers = {}; // Accumulator for broker summary
                const errors = []; // Error collector

                const diffTime = Math.abs(endDate - startDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays > maxDays) return new Response("Range too large (max 60 days)", { status: 400, headers: withCors() });

                // Call centralized calculation logic
                const finalResponse = await this.calculateRangeData(env, symbol, startDate, endDate);

                return new Response(JSON.stringify(finalResponse), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }

            // ROUTE 9: Cached Chart Data Endpoint
            if (path === "/chart-data") {
                const symbol = url.searchParams.get("symbol");
                const from = url.searchParams.get("from");
                const to = url.searchParams.get("to");
                const reload = url.searchParams.get("cache-reload") === "true";

                if (!symbol || !from || !to) return new Response("Missing params", { status: 400, headers: withCors() });

                // Key Format: broker/summary/{symbol}/{start}_{end}.json
                const key = `broker/summary/${symbol}/${from}_${to}.json`;

                // 1. Try Cache
                if (!reload) {
                    try {
                        const cached = await env.SSSAHAM_EMITEN.get(key);
                        if (cached) {
                            return new Response(cached.body, {
                                headers: withCors({ "Content-Type": "application/json", "X-Cache": "HIT" })
                            });
                        }
                    } catch (e) { console.error("Cache read error", e); }
                }

                // 2. Calculate
                const data = await this.calculateRangeData(env, symbol, new Date(from), new Date(to));

                // Add metadata
                data.meta = {
                    generated_at: new Date().toISOString(),
                    range: { from, to }
                };

                // 3. Save Cache
                try {
                    await env.SSSAHAM_EMITEN.put(key, JSON.stringify(data));
                } catch (e) { console.error("Cache write error", e); }

                return new Response(JSON.stringify(data), {
                    headers: withCors({ "Content-Type": "application/json", "X-Cache": reload ? "RELOAD" : "MISS" })
                });
            }

            // ROUTE 10: Get Brokers Mapping (from D1)
            if (path === "/brokers") {
                try {
                    const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();

                    // Transform array to object { "ZP": { name: "...", ... } }
                    const brokersMap = {};
                    if (results) {
                        results.forEach(b => {
                            brokersMap[b.code] = b;
                        });
                    }

                    return new Response(JSON.stringify({ brokers: brokersMap }), {
                        headers: withCors({ "Content-Type": "application/json" })
                    });
                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message }), {
                        status: 500,
                        headers: withCors({ "Content-Type": "application/json" })
                    });
                }
            }

            // FALLBACK: 404 Not Found
            return new Response("Not Found. Available: /update-watchlist, /scrape, /backfill-queue, /read-broksum, /read-broksum-range, /watchlist, /brokers, /chart-data", { status: 404, headers: withCors() });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
                status: 500,
                headers: withCors({ "Content-Type": "application/json" })
            });
        }
    },


    // Helper: Run Screener (Background Job)
    async runScreener(env) {
        console.log("Starting Smart Money Screener...");
        const engine = new SmartMoney();
        const results = [];
        const errors = [];

        // 1. Get All Active Emiten
        const watchlist = await this.getActiveEmiten(env); // approx 700
        console.log(`Analyzing ${watchlist.length} stocks...`);

        // 2. Define Time Window (Last 90 days)
        // We need enough data for 20-day MA + trends
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - 90);

        // 3. Process in Batches (Parallel)
        // Cloudflare Worker CPU time limit is tight (10ms-30s depending on plan)
        // We must be careful. If too many, we might need Durable Object or Queue.
        // For 700 stocks, calculating data means reading R2 700 times * 90 files? NO!
        // fetching chart-data uses `calculateRangeData` which does reading.
        // Reading 90 files * 700 stocks = 63,000 R2 reads. This is EXPENSIVE and SLOW.
        // OPTIMIZATION: Use the `broker/summary/{symbol}/{start}_{end}.json` CACHE if available?
        // OR better: Just analyze the last 90 days.

        // LIMITATION: Doing this for 700 stocks in one request MIGHT TIMEOUT.
        // We will process top 50 for now or use `ctx.waitUntil` creatively?
        // Better: Queue based? 
        // For this implementation, we will try to process them, but if it's too slow we might need to break it down.
        // Let's attempt a batch of 50 concurrency.

        const batchSize = 10; // Conservative batch size
        for (let i = 0; i < watchlist.length; i += batchSize) {
            const batch = watchlist.slice(i, i + batchSize);
            console.log(`Processing batch ${i} - ${i + batchSize}`);

            const promises = batch.map(async (symbol) => {
                try {
                    // Reuse calculateRangeData logic
                    // This reads R2 daily files. 
                    const data = await this.calculateRangeData(env, symbol, startDate, endDate);

                    if (data && data.history) {
                        const analysis = engine.analyze(data.history);
                        if (analysis) {
                            return { symbol, ...analysis };
                        }
                    }
                } catch (e) {
                    console.error(`Error analyzing ${symbol}:`, e);
                }
                return null;
            });

            const batchResults = (await Promise.all(promises)).filter(r => r !== null);
            results.push(...batchResults);

            // Short pause to yield I/O?
        }

        // 4. Sort Globally
        // Priority: READY_MARKUP > TRANSITION > ACCUMULATION > NEUTRAL > DISTRIBUTION
        const statePriority = {
            'READY_MARKUP': 1,
            'TRANSITION': 2,
            'ACCUMULATION': 3,
            'NEUTRAL': 4,
            'DISTRIBUTION': 5
        };

        results.sort((a, b) => {
            const sA = statePriority[a.state] || 99;
            const sB = statePriority[b.state] || 99;
            if (sA !== sB) return sA - sB;
            return b.score - a.score;
        });

        // 5. Store Result
        const output = {
            generated_at: new Date().toISOString(),
            count: results.length,
            candidates: results
        };

        await env.SSSAHAM_WATCHLIST.put("SCREENER_RESULT", JSON.stringify(output));
        console.log("Screener completed and saved.");

        // Optional: Webhook
        await this.sendWebhook(env, `✅ **Smart Money Screener Finished**\nAnalyzed: ${watchlist.length}\nQualified: ${results.length}`);
    },

    // Refactored Helper: Calculate Broker Summary for a Date Range
    async calculateRangeData(env, symbol, startDate, endDate) {
        const results = [];
        const accBrokers = {}; // Accumulator for broker summary
        const errors = []; // Error collector

        // 0. Fetch Brokers Mapping for categorization
        let brokersMap = {};
        try {
            const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
            if (results) {
                results.forEach(b => {
                    brokersMap[b.code] = b;
                });
            }
        } catch (e) {
            console.error("Error fetching brokers mapping:", e);
        }

        // Loop through dates
        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            const key = `${symbol}/${dateStr}.json`;

            try {
                const object = await env.RAW_BROKSUM.get(key);
                if (object) {
                    const fullOuter = await object.json();
                    if (fullOuter && fullOuter.data) {
                        const bd = fullOuter.data.bandar_detector;
                        const bs = fullOuter.data.broker_summary;

                        // 1. Calculate Daily Flow (Foreign, Retail, Local)
                        let foreignBuy = 0, foreignSell = 0;
                        let retailBuy = 0, retailSell = 0;
                        let localBuy = 0, localSell = 0;

                        // Helper to identify Retail vs Local
                        const isRetail = (code) => {
                            const b = brokersMap[code];
                            if (!b) return false;
                            const cat = (b.category || '').toLowerCase();
                            return cat.includes('retail');
                        };

                        // 2. Aggregate
                        if (bs) {
                            // Process Buys
                            if (bs.brokers_buy && Array.isArray(bs.brokers_buy)) {
                                bs.brokers_buy.forEach(b => {
                                    if (!b) return;
                                    const val = parseFloat(b.bval || 0);
                                    const vol = parseFloat(b.blotv || 0) || (parseFloat(b.blot || 0) * 100);
                                    const code = b.netbs_broker_code;

                                    // Determine Type for Daily Flow
                                    if (isRetail(code)) {
                                        retailBuy += val;
                                    } else if (b.type === "Asing") {
                                        foreignBuy += val;
                                    } else {
                                        localBuy += val;
                                    }

                                    if (code) {
                                        if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                                        accBrokers[code].bval += val;
                                        accBrokers[code].bvol += vol;
                                    }
                                });
                            }
                            // Process Sells
                            if (bs.brokers_sell && Array.isArray(bs.brokers_sell)) {
                                bs.brokers_sell.forEach(b => {
                                    if (!b) return;
                                    const val = parseFloat(b.sval || 0);
                                    const vol = parseFloat(b.slotv || 0) || (parseFloat(b.slot || 0) * 100);
                                    const code = b.netbs_broker_code;

                                    if (isRetail(code)) {
                                        retailSell += val;
                                    } else if (b.type === "Asing") {
                                        foreignSell += val;
                                    } else {
                                        localSell += val;
                                    }

                                    if (code) {
                                        if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                                        accBrokers[code].sval += val;
                                        accBrokers[code].svol += vol;
                                    }
                                });
                            }
                        }

                        const summary = {
                            detector: bd,
                            foreign: {
                                buy_val: foreignBuy,
                                sell_val: foreignSell,
                                net_val: foreignBuy - foreignSell
                            },
                            retail: {
                                buy_val: retailBuy,
                                sell_val: retailSell,
                                net_val: retailBuy - retailSell
                            },
                            local: {
                                buy_val: localBuy,
                                sell_val: localSell,
                                net_val: localBuy - localSell
                            }
                        };
                        results.push({ date: dateStr, data: summary });
                    }
                }
            } catch (e) {
                console.error(`Error reading ${key}:`, e);
                errors.push({ date: dateStr, error: e.message });
            }
        }

        // POST-LOOP: Format Aggregated Brokers
        const buyers = Object.keys(accBrokers)
            .map(k => ({ code: k, ...accBrokers[k] }))
            .sort((a, b) => b.bval - a.bval)
            .map(b => ({
                code: b.code,
                val: b.bval,
                vol: b.bvol,
                avg: b.bvol > 0 ? (b.bval / b.bvol) : 0,
                type: b.type
            }))
            .slice(0, 20);

        const sellers = Object.keys(accBrokers)
            .map(k => ({ code: k, ...accBrokers[k] }))
            .sort((a, b) => b.sval - a.sval)
            .map(b => ({
                code: b.code,
                val: b.sval,
                vol: b.svol,
                avg: b.svol > 0 ? (b.sval / b.svol) : 0,
                type: b.type
            }))
            .slice(0, 20);

        const allNetBrokers = Object.keys(accBrokers)
            .map(k => ({
                code: k,
                ...accBrokers[k],
                net: accBrokers[k].bval - accBrokers[k].sval
            }))
            .map(b => ({
                code: b.code,
                bval: b.bval,
                sval: b.sval,
                bvol: b.bvol,
                svol: b.svol,
                net: b.net,
                type: b.type
            }));

        const topNetBuyers = allNetBrokers.filter(b => b.net > 0).sort((a, b) => b.net - a.net).slice(0, 20);
        const topNetSellers = allNetBrokers.filter(b => b.net < 0).sort((a, b) => a.net - b.net).slice(0, 20);

        return {
            history: results,
            summary: {
                top_buyers: buyers,
                top_sellers: sellers,
                top_net_buyers: topNetBuyers,
                top_net_sellers: topNetSellers
            },
            debug_errors: errors.length > 0 ? errors : undefined
        };
    },

    async scheduled(event, env, ctx) {
        // Run backfill batch if active
        const active = await env.SSSAHAM_WATCHLIST.get("BACKFILL_ACTIVE");
        if (active === "true") {
            console.log("Cron Triggered: Processing next backfill batch...");
            await this.processNextBackfillBatch(env);
        } else {
            console.log("Cron Triggered but Backfill is PAUSED.");
        }
    },

    // Helper: Process Next Backfill Batch (Cursor Based)
    async processNextBackfillBatch(env) {
        // 1. Get List
        const watchlist = await this.getActiveEmiten(env);
        if (watchlist.length === 0) return { error: "No emiten" };

        // 2. Get Cursor
        let cursor = parseInt(await env.SSSAHAM_WATCHLIST.get("BACKFILL_CURSOR") || "0");
        if (cursor >= watchlist.length) {
            await this.sendWebhook(env, "✅ **Automated Backfill Finished!** Resetting cursor.");
            await env.SSSAHAM_WATCHLIST.put("BACKFILL_ACTIVE", "false"); // Stop
            return { status: "finished" };
        }

        // 3. Process Item
        const symbol = watchlist[cursor];
        console.log(`Processing Cursor ${cursor}: ${symbol}`);

        const days = 365;
        const tradingDays = getTradingDays(days);
        const batchSize = 100;
        let dispatched = 0;
        const messages = [];

        // Check R2 existence (we have time for 1 symbol)
        for (const date of tradingDays) {
            const key = `${symbol}/${date}.json`;
            const exists = await objectExists(env, key);
            if (!exists) {
                messages.push({ body: { symbol, date, overwrite: false } });
            }
        }

        // Dispatch
        if (messages.length > 0) {
            for (let i = 0; i < messages.length; i += batchSize) {
                const chunk = messages.slice(i, i + batchSize);
                await env.SSSAHAM_QUEUE.sendBatch(chunk);
            }
            dispatched = messages.length;
        }

        // 4. Update Cursor & Log
        const nextCursor = cursor + 1;
        await env.SSSAHAM_WATCHLIST.put("BACKFILL_CURSOR", nextCursor.toString());

        // Notify (Maybe every 50 items or if 1st item)
        if (cursor % 50 === 0 || cursor === 0) {
            await this.sendWebhook(env, `🔄 **Auto-Backfill Progress**: ${cursor}/${watchlist.length}\nCurrent: ${symbol}\nDispatched: ${dispatched} jobs`);
        }

        return { symbol, cursor, dispatched };
    },

    // Helper: Update Watchlist
    async updateWatchlist(env) {
        const TOKEN = await getToken(env);
        const TEMPLATE_IDS = [97, 96, 92, 106, 63, 108];
        const uniqueSymbols = new Set();
        const errors = [];

        console.log("Starting watchlist update...");

        await Promise.all(TEMPLATE_IDS.map(async (id) => {
            const url = `https://exodus.stockbit.com/screener/templates/${id}?type=1&limit=50`;
            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        "Host": "exodus.stockbit.com",
                        "Connection": "keep-alive",
                        "X-Platform": "desktop",
                        "Authorization": `Bearer ${TOKEN}`,
                        "sec-ch-ua-platform": "\"Windows\"",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                        "Accept": "application/json, text/plain, */*",
                        "sec-ch-ua": "\"Microsoft Edge WebView2\";v=\"143\", \"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
                        "sec-ch-ua-mobile": "?0",
                        "Origin": "https://tauri.localhost",
                        "Sec-Fetch-Site": "cross-site",
                        "Sec-Fetch-Mode": "cors",
                        "Sec-Fetch-Dest": "empty",
                        "Referer": "https://tauri.localhost/",
                        "Accept-Encoding": "gzip, deflate, br, zstd",
                        "Accept-Language": "en-US,en;q=0.9"
                    }
                });

                if (!response.ok) {
                    console.error(`Failed to fetch template ${id}: ${response.status}`);
                    errors.push(`Template ${id} failed: ${response.status}`);
                    return;
                }

                const data = await response.json();
                if (data && data.data && data.data.calcs) {
                    for (const item of data.data.calcs) {
                        if (item.company && item.company.symbol) {
                            uniqueSymbols.add(item.company.symbol);
                        }
                    }
                }
            } catch (err) {
                console.error(`Error fetching template ${id}:`, err);
                errors.push(`Template ${id} error: ${err.message}`);
            }
        }));

        const watchlist = Array.from(uniqueSymbols).sort();

        // FALLBACK: If screener API fails, list existing symbols from R2
        let finalWatchlist = watchlist;
        if (watchlist.length === 0 && errors.length > 0) {
            console.log("Screener API failed, using R2 existing symbols as fallback...");
            try {
                // List with delimiter '/' to get directories (symbols)
                const listed = await env.RAW_BROKSUM.list({ delimiter: '/' });

                // delimitingPrefixes contains the folders (e.g. "BBCA/")
                if (listed.delimitedPrefixes && listed.delimitedPrefixes.length > 0) {
                    finalWatchlist = listed.delimitedPrefixes.map(prefix => prefix.replace(/\/$/, ''));
                } else {
                    console.log("No existing symbols found in R2.");
                }
            } catch (r2Err) {
                console.error("Failed to list R2 objects for fallback:", r2Err);
            }
        }

        const output = {
            updated_at: new Date().toISOString(),
            total_symbols: finalWatchlist.length,
            watchlist: finalWatchlist,
            errors: errors,
            is_fallback: watchlist.length === 0 && errors.length > 0
        };

        // Save to KV
        if (env.SSSAHAM_WATCHLIST) {
            await env.SSSAHAM_WATCHLIST.put("LATEST", JSON.stringify(output));
        } else {
            errors.push("KV namespace SSSAHAM_WATCHLIST is not bound.");
        }

        return new Response(JSON.stringify({
            message: "Watchlist updated successfully",
            data: output
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    // Helper: Dispatch Scrape Jobs for single date
    async dispatchScrapeJobs(env, date, overwrite = false) {
        console.log(`Triggered scraping for date: ${date}, overwrite: ${overwrite}`);

        const watchlistData = await env.SSSAHAM_WATCHLIST.get("LATEST", { type: "json" });
        if (!watchlistData || !watchlistData.watchlist) {
            return new Response("Watchlist not found in KV. Please run /update-watchlist first.", { status: 404 });
        }

        const watchlist = watchlistData.watchlist;
        const messages = [];
        let skipped = 0;

        // Check which files already exist
        for (const symbol of watchlist) {
            const key = `${symbol}/${date}.json`;

            // Should check existence only if overwrite IS FALSE
            let exists = false;
            if (!overwrite) {
                exists = await objectExists(env, key);
            }

            if (!exists) {
                messages.push({ body: { symbol, date, overwrite } });
            } else {
                skipped++;
            }
        }

        // Dispatch in batches of 50
        const chunkSize = 50;
        for (let i = 0; i < messages.length; i += chunkSize) {
            const chunk = messages.slice(i, i + chunkSize);
            await env.SSSAHAM_QUEUE.sendBatch(chunk);
        }

        return new Response(JSON.stringify({
            message: `Dispatched ${messages.length} jobs to queue (skipped ${skipped} existing)`,
            date: date,
            dispatched: messages.length,
            skipped: skipped,
            total_symbols: watchlist.length,
            overwrite: overwrite
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    // Helper: Backfill N days
    async backfill90Days(env, days = 90, overwrite = false) {
        console.log(`Starting backfill for ${days} trading days... Overwrite: ${overwrite}`);

        const watchlistData = await env.SSSAHAM_WATCHLIST.get("LATEST", { type: "json" });
        if (!watchlistData || !watchlistData.watchlist) {
            return new Response("Watchlist not found in KV. Please run /update-watchlist first.", { status: 404 });
        }

        const watchlist = watchlistData.watchlist;
        const tradingDays = getTradingDays(days);

        let totalDispatched = 0;
        let totalSkipped = 0;

        // For each trading day, dispatch jobs
        for (const date of tradingDays) {
            const messages = [];

            for (const symbol of watchlist) {
                const key = `${symbol}/${date}.json`;

                let exists = false;
                if (!overwrite) {
                    exists = await objectExists(env, key);
                }

                if (!exists) {
                    messages.push({ body: { symbol, date, overwrite } });
                } else {
                    totalSkipped++;
                }
            }

            // Dispatch in batches
            const chunkSize = 50;
            for (let i = 0; i < messages.length; i += chunkSize) {
                const chunk = messages.slice(i, i + chunkSize);
                await env.SSSAHAM_QUEUE.sendBatch(chunk);
            }

            totalDispatched += messages.length;
            console.log(`Date ${date}: dispatched ${messages.length} jobs`);
        }

        return new Response(JSON.stringify({
            message: `Backfill completed for ${days} trading days`,
            total_dispatched: totalDispatched,
            total_skipped: totalSkipped,
            trading_days: tradingDays.length,
            symbols_count: watchlist.length,
            overwrite: overwrite
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    // Helper: Get Active Emiten from D1 (Strip .JK suffix)
    async getActiveEmiten(env) {
        try {
            const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten WHERE status = 'ACTIVE'").all();
            if (!results) return [];
            // Strip .JK suffix
            return results.map(r => r.ticker.replace(/\.JK$/, ''));
        } catch (e) {
            console.error("Error fetching active emiten from D1:", e);
            return [];
        }
    },

    // Helper: Send Webhook Notification (via Service Binding)
    async sendWebhook(env, message) {
        if (!env.NOTIF_SERVICE) {
            console.log("No NOTIF_SERVICE binding, skipping notification:", message);
            return;
        }
        try {
            await env.NOTIF_SERVICE.fetch("http://internal/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: message })
            });
        } catch (e) {
            console.error("Failed to send webhook via service:", e);
        }
    },

    // Helper: Backfill Active Emiten (D1 source, N days)
    async backfillActiveEmiten(env, days = 5, overwrite = false, fromDate = null) {
        const startMsg = `🚀 **Starting INIT Backfill**\nDays: ${days}\nOverwrite: ${overwrite}\nStart Date: ${fromDate || 'Today'}\nSource: D1 (Active Emiten)`;
        console.log(startMsg);
        await this.sendWebhook(env, startMsg);

        const watchlist = await this.getActiveEmiten(env);
        if (watchlist.length === 0) {
            await this.sendWebhook(env, "⚠️ **Backfill Aborted**: No active emiten found in D1.");
            return new Response("No active emiten found in D1. Please seed database first.", { status: 404 });
        }

        const effectiveStart = fromDate ? new Date(fromDate) : new Date();
        const tradingDays = getTradingDays(days, effectiveStart);
        let totalDispatched = 0;
        let totalSkipped = 0;
        const batchSize = 100; // Queue batch size

        // Optimization: Create all messages first? No, memory limit.
        // Process day by day.

        for (const date of tradingDays) {
            const messages = [];

            // Check existence logic can be slow if we do it one by one for 700*300 items.
            // But we must do it if not overwriting.
            // Optimization: Maybe listing R2 is faster? No, too many files.
            // We'll stick to strict checking or just blind dispatch if overwrite is true?
            // If overwrite=true, we skip checking.

            for (const symbol of watchlist) {
                if (!overwrite) {
                    const key = `${symbol}/${date}.json`;
                    const exists = await objectExists(env, key);
                    if (exists) {
                        totalSkipped++;
                        continue;
                    }
                }
                messages.push({ body: { symbol, date, overwrite } });
            }

            // Dispatch this day's messages in batches
            if (messages.length > 0) {
                for (let i = 0; i < messages.length; i += batchSize) {
                    const chunk = messages.slice(i, i + batchSize);
                    await env.SSSAHAM_QUEUE.sendBatch(chunk);
                }
                totalDispatched += messages.length;
                console.log(`Date ${date}: dispatched ${messages.length} jobs`);
            }
        }

        const endMsg = `✅ **INIT Backfill Completed**\nTotal Dispatched: ${totalDispatched}\nTotal Skipped: ${totalSkipped}\nTrading Days: ${tradingDays.length}\nSymbols: ${watchlist.length}`;
        await this.sendWebhook(env, endMsg);

        return new Response(JSON.stringify({
            message: `Init Backfill completed for ${days} trading days`,
            total_dispatched: totalDispatched,
            total_skipped: totalSkipped,
            trading_days: tradingDays.length,
            symbols_count: watchlist.length,
            overwrite: overwrite
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    async queue(batch, env) {
        const TOKEN = await getToken(env);

        for (const message of batch.messages) {
            const { symbol, date, overwrite } = message.body;

            const startTime = Date.now();
            console.log(`Processing ${symbol} for ${date} (overwrite: ${overwrite})`);

            try {
                // Check if already exists (double-check), UNLESS overwrite is true
                const key = `${symbol}/${date}.json`;

                if (!overwrite) {
                    const exists = await objectExists(env, key);
                    if (exists) {
                        console.log(`Skipping ${key} - already exists`);
                        await env.SSSAHAM_DB.prepare("INSERT INTO scraping_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                            .bind(new Date().toISOString(), symbol, date, "SKIPPED", Date.now() - startTime)
                            .run();
                        message.ack();
                        continue;
                    }
                }

                const url = `https://exodus.stockbit.com/marketdetectors/${symbol}?from=${date}&to=${date}&transaction_type=TRANSACTION_TYPE_GROSS&market_board=MARKET_BOARD_REGULER&investor_type=INVESTOR_TYPE_ALL&limit=25`;

                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        "Host": "exodus.stockbit.com",
                        "Connection": "keep-alive",
                        "X-Platform": "desktop",
                        "Authorization": `Bearer ${TOKEN}`,
                        "sec-ch-ua-platform": "\"Windows\"",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                        "Accept": "application/json, text/plain, */*",
                        "sec-ch-ua": "\"Microsoft Edge WebView2\";v=\"143\", \"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
                        "sec-ch-ua-mobile": "?0",
                        "Origin": "https://tauri.localhost",
                        "Sec-Fetch-Site": "cross-site",
                        "Sec-Fetch-Mode": "cors",
                        "Sec-Fetch-Dest": "empty",
                        "Referer": "https://tauri.localhost/",
                        "Accept-Encoding": "gzip, deflate, br, zstd",
                        "Accept-Language": "en-US,en;q=0.9"
                    }
                });

                if (!response.ok) {
                    console.error(`Failed to fetch ${symbol}: ${response.status}`);
                    if (response.status === 401) {
                        // Token expired - retry later
                        message.retry();
                    } else {
                        // Log failure
                        await env.SSSAHAM_DB.prepare("INSERT INTO scraping_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                            .bind(new Date().toISOString(), symbol, date, `FAILED_${response.status}`, Date.now() - startTime)
                            .run();
                        message.ack(); // Don't retry for other errors
                    }
                    continue;
                }

                const data = await response.json();

                // Save to R2
                await env.RAW_BROKSUM.put(key, JSON.stringify(data));
                console.log(`Saved ${key} to R2`);

                await env.SSSAHAM_DB.prepare("INSERT INTO scraping_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                    .bind(new Date().toISOString(), symbol, date, "SUCCESS", Date.now() - startTime)
                    .run();

                message.ack();

            } catch (err) {
                console.error(`Error processing ${symbol}:`, err);
                message.retry();
            }
        }
    }
};
