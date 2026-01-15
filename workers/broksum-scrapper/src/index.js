/**
 * @worker broksum-scrapper
 * @objective Scrapes Broker Summary data from external API (Stockbit) using a rotating token mechanism, processes data via queues, and stores it in R2.
 *
 * @endpoints
 * - GET /update-watchlist?date=... -> Updates watchlist and queues scrape jobs (public/internal)
 * - GET /scrape-queue?date=... -> Manually triggers scrape queue logic (public/internal)
 * - GET /backfill-queue?days=... -> Queues backfill jobs for N days (public/internal)
 * - GET /trigger-full-flow -> Combines watchlist update and backfill trigger (public/internal)
 *
 * @triggers
 * - http: yes
 * - cron: * /2 * * * * (Dispatches scraping jobs or health checks)
 * - queue: sssaham - queue(Consumes scrape jobs)
    * - durable_object: none
        * - alarms: none
            *
 * @io
            * - reads: KV(SSSAHAM_WATCHLIST, Token), R2(Preview)
                * - writes: R2(RAW_BROKSUM), Queue(SSSAHAM_QUEUE)
                    *
 * @relations
                    * - upstream: Stockbit API(External)
                        * - downstream: api - saham(via R2 data)
                            *
 * @success_metrics
                            * - Scrape success rate(tokens valid)
                                * - Queue processing latency
                                    *
 * @notes
                                    * - Uses a hardcoded token fallback system.
 * - Implements complex retry and backoff logic for scraping.
 */



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

            // JOINED FROM DATA: Brokers Mapping (from D1)
            // Useful for debugging scraping
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
                        headers: { "Content-Type": "application/json" }
                    });
                }
            }

            // FALLBACK: 404 Not Found
            return new Response("Not Found. Available: /update-watchlist, /scrape, /backfill-queue, /read-broksum, /watchlist, /brokers, /init, /backfill/*", { status: 404, headers: withCors() });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
                status: 500,
                headers: withCors({ "Content-Type": "application/json" })
            });
        }
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
