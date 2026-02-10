/**
 * * @worker broksum-scrapper
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
 * - cron: * / 2 * * * * (Dispatches scraping jobs or health checks)
 * - queue: sssaham - queue(Consumes scrape jobs)
 *     * - durable_object: none
 *         * - alarms: none
 *             *
 *  * @io
 *             * - reads: KV(SSSAHAM_WATCHLIST, Token), R2(Preview)
 *                 * - writes: R2(RAW_BROKSUM), Queue(SSSAHAM_QUEUE)
 *                     *
 *  * @relations
 *                     * - upstream: Stockbit API(External)
 *                         * - downstream: api - saham(via R2 data)
 *                             *
 *  * @success_metrics
 *                             * - Scrape success rate(tokens valid)
 *                                 * - Queue processing latency
 *                                     *
 *  * @notes
 *                                     * - Uses a hardcoded token fallback system.
 *  * - Implements complex retry and backoff logic for scraping.
 *  */





// Helper: Check if R2 object exists
async function objectExists(env, key) {
    try {
        const head = await env.RAW_BROKSUM.head(key);
        return head !== null;
    } catch (e) {
        return false;
    }
}

// Helper: Get trading days (skip weekends) for last N days - UTC-stable
function getTradingDays(days, startDate = new Date(), startOffsetDays = 1) {
    const dates = [];
    const base = new Date(startDate);

    // Normalize to UTC midnight to avoid drift
    base.setUTCHours(0, 0, 0, 0);

    let count = 0;
    let offset = startOffsetDays; // Default: start from yesterday UTC

    while (count < days) {
        const d = new Date(base);
        d.setUTCDate(base.getUTCDate() - offset);

        const dow = d.getUTCDay(); // 0 Sun, 6 Sat
        if (dow !== 0 && dow !== 6) {
            dates.push(d.toISOString().slice(0, 10));
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
        "Access-Control-Allow-Headers": "Content-Type"
    };
}

// Helper: Security guard for sensitive endpoints
function requireKey(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!env.INTERNAL_KEY) return null; // No key configured = no guard
    if (key !== env.INTERNAL_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "Forbidden", reason: "INVALID_KEY" }), {
            status: 403,
            headers: withCors({ "Content-Type": "application/json" })
        });
    }
    return null; // Passed
}

// Helper: Generate Sec-WebSocket-Key (RFC 6455 compliant)
function makeWebSocketKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

async function getIpotAppSession(env) {
    // Try primary cache first (TTL 10 min)
    const cached = await env.SSSAHAM_WATCHLIST.get("IPOT_APPSESSION");
    if (cached) return cached;

    const url = env.IPOT_APPSESSION_URL || "https://indopremier.com/ipc/appsession.js";
    const origin = env.IPOT_ORIGIN || "https://indopremier.com";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 sec timeout

    try {
        const resp = await fetch(url, {
            headers: {
                "Accept": "*/*",
                "User-Agent": "broksum-scrapper/1.0",
                "Origin": origin,
                "Referer": origin + "/",
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) throw new Error(`appsession fetch failed: ${resp.status}`);

        const text = await resp.text();

        const patterns = [
            /appsession\s*[:=]\s*["']([^"']+)["']/i,
            /appsession=([a-zA-Z0-9\-_]+)/i,
            /["']appsession["']\s*[:,]\s*["']([^"']+)["']/i,
        ];

        let token = null;
        for (const re of patterns) {
            const m = text.match(re);
            if (m && m[1]) { token = m[1]; break; }
        }

        if (!token) {
            // Safer fallback: look for token NEAR the word "appsession"
            const near = text.match(/appsession[^A-Za-z0-9\-_]{0,30}([A-Za-z0-9\-_]{16,128})/i);
            if (near) token = near[1];
        }

        if (!token) throw new Error(`could not parse appsession from ${url}`);

        // Save to primary cache (10 min TTL) and backup (6 hour TTL - shorter to recover faster from bad cache)
        await env.SSSAHAM_WATCHLIST.put("IPOT_APPSESSION", token, { expirationTtl: 600 });
        await env.SSSAHAM_WATCHLIST.put("IPOT_APPSESSION_BACKUP", token, { expirationTtl: 21600 }); // 6 hours
        return token;
    } catch (e) {
        clearTimeout(timeoutId);

        // STALE-IF-ERROR: Try backup cache if fetch fails
        const backup = await env.SSSAHAM_WATCHLIST.get("IPOT_APPSESSION_BACKUP");
        if (backup) {
            console.warn(`getIpotAppSession fetch failed, using stale backup: ${e.message}`);
            return backup;
        }

        throw e;
    }
}

// Helper: Clear appsession cache (primary + backup) - call when WS upgrade fails
async function clearIpotAppSession(env) {
    try {
        await env.SSSAHAM_WATCHLIST.delete("IPOT_APPSESSION");
        await env.SSSAHAM_WATCHLIST.delete("IPOT_APPSESSION_BACKUP");
    } catch { }
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
            // ROUTE 0: Health Check (Always Available)
            if (path === "/health") {
                return new Response(JSON.stringify({
                    ok: true,
                    timestamp: new Date().toISOString(),
                    service: "broksum-scrapper",
                    version: "2.0.0"
                }), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }

            // IPOT_ONLY mode: restrict to IPOT endpoints only
            if (env.IPOT_ONLY === "true") {
                const allowed = new Set(["/ipot/scrape", "/ipot/reset-session", "/health"]);
                if (!allowed.has(path)) {
                    return new Response(JSON.stringify({ ok: false, error: "Not Found (IPOT_ONLY mode)", reason: "IPOT_ONLY" }), {
                        status: 404,
                        headers: withCors({ "Content-Type": "application/json" })
                    });
                }
            }

            // Security guard for sensitive endpoints (excluding /ipot/scrape for public access)
            const sensitiveRoutes = [
                "/update-watchlist", "/ipot/reset-session",
                "/scrape", "/backfill-queue", "/trigger-full-flow", "/init",
                "/backfill/status", "/backfill/resume", "/backfill/pause", "/backfill/reset",
                "/debug-token", "/test-range", "/auto-backfill"
            ];
            if (sensitiveRoutes.includes(path)) {
                const keyError = requireKey(request, env);
                if (keyError) return keyError;
            }

            // ROUTE 1: Update Watchlist (Fetch from Templates -> Save to KV)
            if (path === "/update-watchlist") {
                return await this.updateWatchlist(env);
            }

            if (path === "/ipot/reset-session") {
                console.log("DEBUG: Resetting session triggered");
                await clearIpotAppSession(env); // delete primary + backup
                return new Response(JSON.stringify({ ok: true, cleared: ["IPOT_APPSESSION", "IPOT_APPSESSION_BACKUP"] }), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
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

            // ROUTE 5: Debug token - REMOVED (Stockbit Deprecated)
            if (path === "/debug-token") {
                return new Response(JSON.stringify({ error: "Endpoint deprecated (Stockbit removed)" }), {
                    status: 410,
                    headers: { "Content-Type": "application/json" }
                });
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

                const provider = url.searchParams.get("provider"); // 'ipot' or empty
                let key = `${symbol}/${date}.json`;
                if (provider === "ipot") {
                    key = `${symbol}/ipot/${date}.json`;
                }
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


            // ROUTE IPOT: Scrape Broker Summary via WebSocket (public)
            if (path === "/ipot/scrape") {
                // Public Guard: IPOT_PUBLIC_KEY (Optional)
                const key = url.searchParams.get("key");
                if (env.IPOT_PUBLIC_KEY && key !== env.IPOT_PUBLIC_KEY) {
                    return new Response(JSON.stringify({ ok: false, error: "Forbidden", reason: "INVALID_PUBLIC_KEY" }), {
                        status: 403,
                        headers: withCors({ "Content-Type": "application/json" })
                    });
                }

                const symbol = (url.searchParams.get("symbol") || "TLKM").toUpperCase();
                // Default to yesterday (safer for timezone issues: UTC vs WIB)
                const defaultDate = (() => {
                    const d = new Date();
                    d.setUTCDate(d.getUTCDate() - 1);
                    return d.toISOString().slice(0, 10);
                })();
                const from = url.searchParams.get("from") || defaultDate;
                const to = url.searchParams.get("to") || from;
                const flag5 = url.searchParams.get("flag5") || "%"; // "%" or "F" dll
                const save = url.searchParams.get("save") === "true"; // optional
                const debug = url.searchParams.get("debug") === "true";
                return await this.scrapeIpotBroksum(env, { symbol, from, to, flag5, save, debug });
            }


            // ROUTE TEST: E2E single symbol + date range (enqueue only)
            if (path === "/test-range") {
                const symbol = (url.searchParams.get("symbol") || "BBCA").toUpperCase();
                const from = url.searchParams.get("from") || new Date().toISOString().slice(0, 10);
                const to = url.searchParams.get("to") || from;
                const overwrite = url.searchParams.get("overwrite") === "true";

                return await this.enqueueSymbolRange(env, { symbol, from, to, overwrite });
            }

            // ROUTE: Check Missing Dates for Single Symbol
            if (path === "/check-missing-dates") {
                const symbol = url.searchParams.get("symbol");
                if (!symbol) {
                    return new Response(JSON.stringify({ ok: false, error: "Missing required parameter: symbol" }), {
                        status: 400,
                        headers: withCors({ "Content-Type": "application/json" })
                    });
                }
                const days = parseInt(url.searchParams.get("days") || "30");
                const missingDates = await this.getMissingDatesForSymbol(env, symbol.toUpperCase(), days);
                return new Response(JSON.stringify({
                    ok: true,
                    symbol: symbol.toUpperCase(),
                    days_checked: days,
                    missing_dates: missingDates,
                    missing_count: missingDates.length
                }), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }

            // ROUTE: Auto Backfill for All Watchlist Symbols (or single symbol)
            if (path === "/auto-backfill") {
                const days = parseInt(url.searchParams.get("days") || "30");
                const dryRun = url.searchParams.get("dry_run") === "true";
                const targetSymbol = url.searchParams.get("symbol"); // Optional single symbol
                const force = url.searchParams.get("force") === "true"; // Force re-scrape even if exists
                return await this.autoBackfillAllSymbols(env, days, dryRun, targetSymbol, force);
            }

            // ROUTE: Scrape Logo for Symbol
            if (path === "/scrape-logo") {
                const symbol = url.searchParams.get("symbol");
                if (!symbol) return new Response("Missing symbol", { status: 400 });
                const result = await this.scrapeLogo(env, symbol);
                return new Response(JSON.stringify(result, null, 2), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // ROUTE: Bulk Scrape Logos for All Watchlist Symbols
            if (path === "/scrape-all-logos") {
                const watchlist = await this.getWatchlistFromKV(env);
                const results = { scraped: 0, skipped: 0, failed: 0, details: [] };

                for (const symbol of watchlist) {
                    const result = await this.scrapeLogo(env, symbol);
                    if (result.ok) {
                        if (result.message.includes("already exists")) {
                            results.skipped++;
                        } else {
                            results.scraped++;
                        }
                    } else {
                        results.failed++;
                    }
                    results.details.push({ symbol, ...result });

                    // Small delay to avoid rate limiting
                    await new Promise(r => setTimeout(r, 100));
                }

                return new Response(JSON.stringify({
                    ok: true,
                    total: watchlist.length,
                    scraped: results.scraped,
                    skipped: results.skipped,
                    failed: results.failed,
                    details: results.details
                }, null, 2), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // ROUTE: Audit Trail for a Symbol
            if (path === "/audit-trail") {
                const symbol = url.searchParams.get("symbol");
                if (!symbol) {
                    return new Response(JSON.stringify({ ok: false, error: "Missing required parameter: symbol" }), {
                        status: 400,
                        headers: withCors({ "Content-Type": "application/json" })
                    });
                }
                const limit = parseInt(url.searchParams.get("limit") || "100");
                const auditTrail = await this.getAuditTrail(env, symbol.toUpperCase(), limit);
                return new Response(JSON.stringify({
                    ok: true,
                    symbol: symbol.toUpperCase(),
                    entries: auditTrail,
                    count: auditTrail.length
                }), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }


            // ROUTE: Clean Specific Date (Delete from R2 for all active emiten)
            if (path === "/clean-date") {
                const keyError = requireKey(request, env);
                if (keyError) return keyError;

                const date = url.searchParams.get("date");
                if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    return new Response("Invalid date format YYYY-MM-DD", { status: 400 });
                }

                // 1. Get List
                const watchlist = await this.getAllEmitenFromDB(env);
                if (watchlist.length === 0) return new Response("No active emiten", { status: 404 });

                // 2. Delete Loop
                let deleted = 0;
                let failed = 0;

                // R2 delete is fast, we can do parallel batches
                const batchSize = 50;
                for (let i = 0; i < watchlist.length; i += batchSize) {
                    const chunk = watchlist.slice(i, i + batchSize);
                    const promises = chunk.map(symbol => {
                        const key = `${symbol}/${date}.json`;
                        return env.RAW_BROKSUM.delete(key).then(() => 1).catch(() => 0);
                    });
                    const results = await Promise.all(promises);
                    deleted += results.reduce((a, b) => a + b, 0);
                }

                return new Response(JSON.stringify({
                    message: `Cleaned date ${date}`,
                    total_symbols: watchlist.length,
                    deleted_ops: deleted // Note: R2 delete returns success even if key didn't exist
                }), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // FALLBACK: 404 Not Found
            return new Response("Not Found. Available: /update-watchlist, /scrape, /backfill-queue, /read-broksum, /watchlist, /brokers, /init, /backfill/*, /test-range", {
                status: 404,
                headers: withCors()
            });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
                status: 500,
                headers: withCors({ "Content-Type": "application/json" })
            });
        }
    },

    // Cron Handler
    async scheduled(event, env, ctx) {
        console.log(`🕐 Scheduled cron triggered at: ${new Date().toISOString()}`);
        console.log(`🕐 Cron Schedule: ${event.cron}`);

        // Get details
        const now = new Date();
        const utcHour = now.getUTCHours();

        // WIB logic for logging
        const wibOffset = 7 * 60 * 60 * 1000;
        const wibDate = new Date(now.getTime() + wibOffset);
        const today = wibDate.toISOString().slice(0, 10);
        const wibHour = wibDate.getUTCHours();

        console.log(`📅 UTC Hour: ${utcHour}, WIB Date: ${today}, WIB Hour: ${wibHour}`);

        // Skip weekends (WIB)
        const dow = wibDate.getUTCDay();
        if (dow === 0 || dow === 6) {
            console.log(`⏭️ Skipping weekend (day ${dow})`);
            return;
        }

        try {
            // 1. Get Watchlist
            const watchlist = await this.getWatchlistFromKV(env);
            if (!watchlist || watchlist.length === 0) {
                return;
            }

            // MODE SELECTION
            // If cron is "0 11 * * *" (11:00 UTC / 18:00 WIB) -> DAILY REWRITE
            // Checks strictly if UTC Hour is 11
            const isDailyRewrite = (utcHour === 11);

            if (isDailyRewrite) {
                console.log("🚀 MODE: DAILY REWRITE (18:00 WIB) - Overwriting Today's Data");

                // Queuing "Today" with overwrite=true for ALL symbols
                let dispatched = 0;
                const batchSize = 50;
                let messages = [];

                for (const symbol of watchlist) {
                    messages.push({ body: { symbol, date: today, overwrite: true, attempt: 0 } });

                    if (messages.length >= batchSize) {
                        await env.SSSAHAM_QUEUE.sendBatch(messages);
                        dispatched += messages.length;
                        messages = [];
                    }
                }
                if (messages.length > 0) {
                    await env.SSSAHAM_QUEUE.sendBatch(messages);
                    dispatched += messages.length;
                }

                const msg = `✅ **Daily Rewrite Dispatched**\nDate: ${today}\nSymbols: ${dispatched} (Overwrite: True)`;
                console.log(msg);
                await this.sendWebhook(env, msg);

            } else {
                console.log("🧹 MODE: SWEEPING (Backfill Holes) - Last 90 Days (Excl. Today)");

                // Sweeping Logic: Check missing dates 90 days back, EXCLUDING today
                // overwrite=false
                const lookbackDays = 90;
                let totalMissingQueued = 0;
                let processedSymbols = 0;

                for (const symbol of watchlist) {
                    // Check missing
                    const missingDates = await this.getMissingDatesForSymbol(env, symbol, lookbackDays);

                    // Filter out TODAY if it slipped in (though getMissingDatesForSymbol logic might include it depending on "getTradingDays")
                    // Verification: getTradingDays starts from "startDate", offset 1 (yesterday). 
                    // Let's ensure we are strict.
                    const finalMissing = missingDates.filter(d => d !== today);

                    if (finalMissing.length > 0) {
                        console.log(`🔍 ${symbol} missing ${finalMissing.length} days. Queuing...`);

                        const messages = finalMissing.map(d => ({
                            body: { symbol, date: d, overwrite: false, attempt: 0 }
                        }));

                        // Send batch
                        // Chunking if needed (queue limits)
                        for (let i = 0; i < messages.length; i += 50) {
                            await env.SSSAHAM_QUEUE.sendBatch(messages.slice(i, i + 50));
                        }
                        totalMissingQueued += finalMissing.length;
                    }

                    processedSymbols++;
                    // Yield slightly
                    if (processedSymbols % 10 === 0) await new Promise(r => setTimeout(r, 20));
                }

                if (totalMissingQueued > 0) {
                    const msg = `🧹 **Sweeping Complete**\nQueued ${totalMissingQueued} missing dates for backfill.`;
                    console.log(msg);
                    await this.sendWebhook(env, msg);
                } else {
                    console.log("🧹 Sweeping clean. No missing dates found.");
                }
            }

        } catch (e) {
            console.error(`❌ Scheduled cron error: ${e.message}`);
            await this.sendWebhook(env, `❌ **Cron Failed**\nError: ${e.message}`);
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
            await env.SSSAHAM_WATCHLIST.put("BACKFILL_CURSOR", "0"); // Reset cursor
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

        // Check R2 existence (optimize with list + pagination)
        const existingDates = new Set();
        try {
            let listCursor;
            do {
                const listed = await env.RAW_BROKSUM.list({
                    prefix: `${symbol}/`,
                    cursor: listCursor
                });

                for (const obj of listed.objects) {
                    // key format: SYMBOL/YYYY-MM-DD.json
                    const parts = obj.key.split('/');
                    if (parts.length === 2) {
                        const date = parts[1].replace('.json', '');
                        existingDates.add(date);
                    }
                }

                listCursor = listed.truncated ? listed.cursor : undefined;
            } while (listCursor);

        } catch (e) {
            console.error(`Error listing R2 for ${symbol}:`, e);
        }

        for (const date of tradingDays) {
            if (!existingDates.has(date)) {
                messages.push({ body: { symbol, date, overwrite: false, attempt: 0 } });
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

    // Helper: Update Watchlist (From D1)
    async updateWatchlist(env) {
        console.log("Starting watchlist update (Source: D1)...");
        const errors = [];
        let watchlist = [];

        try {
            // 1. Fetch from D1
            const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten WHERE status = 'ACTIVE'").all();
            if (results && results.length > 0) {
                // Strip .JK if present
                watchlist = results.map(r => r.ticker.replace(/\.JK$/, '')).sort();
                console.log(`Fetched ${watchlist.length} symbols from D1`);
            } else {
                errors.push("D1 returned no symbols or error.");
            }
        } catch (e) {
            console.error("D1 Fetch Error:", e);
            errors.push(`D1 Error: ${e.message}`);
        }

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

        // COST OPT: Logic moved to Consumer. Dispatch ALL to queue.
        // Consumer will check R2 existence before scraping.
        for (const symbol of watchlist) {
            messages.push({ body: { symbol, date, overwrite, attempt: 0 } });
        }

        // Dispatch in batches of 50
        const chunkSize = 50;
        for (let i = 0; i < messages.length; i += chunkSize) {
            const chunk = messages.slice(i, i + chunkSize);
            await env.SSSAHAM_QUEUE.sendBatch(chunk);
        }

        return new Response(JSON.stringify({
            message: `Dispatched ${messages.length} jobs to queue (Optimized: Check logic in consumer)`,
            date: date,
            dispatched: messages.length,
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

        // For each trading day, dispatch jobs (BLIND DISPATCH - Consumer does existence check)
        for (const date of tradingDays) {
            const messages = [];

            for (const symbol of watchlist) {
                messages.push({ body: { symbol, date, overwrite, attempt: 0 } });
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
            message: `Backfill completed for ${days} trading days (Dispatcher optimized)`,
            total_dispatched: totalDispatched,
            trading_days: tradingDays.length,
            symbols_count: watchlist.length,
            overwrite: overwrite
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    // Helper: list dates between from..to (inclusive), skip weekends
    dateRangeTradingDays(from, to) {
        const out = [];
        const start = new Date(from + "T00:00:00Z");
        const end = new Date(to + "T00:00:00Z");
        if (isNaN(start) || isNaN(end)) return out;

        const dir = start <= end ? 1 : -1;
        for (let d = new Date(start); dir > 0 ? d <= end : d >= end; d.setUTCDate(d.getUTCDate() + dir)) {
            const dow = d.getUTCDay(); // 0 Sun, 6 Sat
            if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
        }
        return out;
    },

    // Helper: enqueue 1 symbol for range dates (end-to-end via queue consumer)
    async enqueueSymbolRange(env, { symbol, from, to, overwrite }) {
        const dates = this.dateRangeTradingDays(from, to);

        if (!dates.length) {
            return new Response(JSON.stringify({ ok: false, error: "Invalid date range / no trading days", symbol, from, to }), {
                status: 400,
                headers: withCors({ "Content-Type": "application/json" })
            });
        }

        const batchSize = 100;
        let enqueued = 0;
        let skipped = 0;

        const messages = [];
        for (const date of dates) {
            if (!overwrite) {
                const key = `${symbol}/${date}.json`;
                const exists = await objectExists(env, key);
                if (exists) { skipped++; continue; }
            }

            messages.push({ body: { symbol, date, overwrite, attempt: 0 } });
        }

        for (let i = 0; i < messages.length; i += batchSize) {
            await env.SSSAHAM_QUEUE.sendBatch(messages.slice(i, i + batchSize));
        }
        enqueued = messages.length;

        return new Response(JSON.stringify({
            ok: true,
            mode: "enqueue_range",
            symbol,
            from,
            to,
            trading_days: dates.length,
            overwrite,
            enqueued,
            skipped,
            sample_dates: dates.slice(0, 5)
        }), {
            headers: withCors({ "Content-Type": "application/json" })
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

    // Helper: Get Missing Dates for a Symbol (Check R2)
    async getMissingDatesForSymbol(env, symbol, days = 30) {
        const tradingDays = getTradingDays(days);
        const missingDates = [];

        // List existing files for this symbol
        const existingDates = new Set();
        try {
            let listCursor;
            do {
                const listed = await env.RAW_BROKSUM.list({
                    prefix: `${symbol}/`,
                    cursor: listCursor
                });

                for (const obj of listed.objects) {
                    // key format: SYMBOL/YYYY-MM-DD.json or SYMBOL/ipot/YYYY-MM-DD.json
                    const parts = obj.key.split('/');
                    if (parts.length >= 2) {
                        // Extract date from filename
                        const filename = parts[parts.length - 1];
                        const date = filename.replace('.json', '');
                        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                            existingDates.add(date);
                        }
                    }
                }

                listCursor = listed.truncated ? listed.cursor : undefined;
            } while (listCursor);
        } catch (e) {
            console.error(`Error listing R2 for ${symbol}:`, e);
        }

        // Find missing dates
        for (const date of tradingDays) {
            if (!existingDates.has(date)) {
                missingDates.push(date);
            }
        }

        return missingDates;
    },

    // Helper: Auto Backfill All Symbols (via IPOT)
    async autoBackfillAllSymbols(env, days = 30, dryRun = false, targetSymbol = null, force = false) {
        const timestamp = new Date().toISOString();
        const watchlist = await this.getWatchlistFromKV(env);

        if (!watchlist || watchlist.length === 0) {
            return new Response(JSON.stringify({
                ok: false,
                error: "No watchlist found. Please run /update-watchlist first."
            }), {
                status: 404,
                headers: withCors({ "Content-Type": "application/json" })
            });
        }

        // If filtering by symbol
        if (targetSymbol) {
            const s = targetSymbol.toUpperCase();
            if (watchlist.includes(s)) {
                // Replace watchlist with just this one symbol
                // We restart the array, but it's fine since we loop it
                watchlist.length = 0;
                watchlist.push(s);
            } else {
                return new Response(JSON.stringify({ ok: false, error: `${s} not in watchlist` }), {
                    status: 400,
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }
        }

        const details = [];
        let totalMissingDates = 0;
        let totalScraped = 0;
        let totalFailed = 0;

        for (const symbol of watchlist) {
            let missingDates = [];
            if (force) {
                // Force mode: Generate all dates for last N days (excluding weekends)
                const today = new Date();
                for (let i = 0; i < days; i++) {
                    const d = new Date(today);
                    d.setDate(d.getDate() - i);
                    if (d.getDay() !== 0 && d.getDay() !== 6) {
                        missingDates.push(d.toISOString().split('T')[0]);
                    }
                }
            } else {
                missingDates = await this.getMissingDatesForSymbol(env, symbol, days);
            }

            if (missingDates.length > 0) {
                const symbolDetail = {
                    symbol,
                    missing_count: missingDates.length,
                    missing_dates: missingDates,
                    scraped: 0,
                    failed: 0
                };

                totalMissingDates += missingDates.length;

                // Scrape via IPOT if not dry run
                if (!dryRun) {
                    for (const date of missingDates) {
                        try {
                            const result = await this.scrapeIpotBroksum(env, {
                                symbol,
                                from: date,
                                to: date,
                                flag5: "%",
                                save: true,
                                debug: false
                            });

                            const resultData = await result.json();
                            if (resultData.ok !== false && !resultData.error) {
                                totalScraped++;
                                symbolDetail.scraped++;
                            } else {
                                totalFailed++;
                                symbolDetail.failed++;
                            }
                        } catch (e) {
                            totalFailed++;
                            symbolDetail.failed++;
                            console.error(`Backfill error ${symbol}/${date}: ${e.message}`);
                        }

                        // Delay between dates
                        await new Promise(r => setTimeout(r, 100));
                    }
                }

                details.push(symbolDetail);
            }

            // Small delay to avoid overwhelming R2
            await new Promise(r => setTimeout(r, 50));
        }

        const report = {
            timestamp,
            days_checked: days,
            total_symbols: watchlist.length,
            symbols_with_missing: details.length,
            total_missing_dates: totalMissingDates,
            total_scraped: totalScraped,
            total_failed: totalFailed,
            dry_run: dryRun,
            details
        };

        const message = dryRun
            ? "Backfill report generated (dry run - no scraping performed)"
            : `Backfill completed: ${totalScraped} scraped, ${totalFailed} failed`;

        // Send notification if not dry run
        if (!dryRun && totalMissingDates > 0) {
            await this.sendWebhook(env, `🔄 **Auto Backfill Completed**\n` +
                `• Total Symbols: ${watchlist.length}\n` +
                `• Symbols with missing: ${details.length}\n` +
                `• Scraped: ${totalScraped}\n` +
                `• Failed: ${totalFailed}`);
        }

        return new Response(JSON.stringify({
            ok: true,
            message,
            report
        }), {
            headers: withCors({ "Content-Type": "application/json" })
        });
    },

    // Helper: Get Audit Trail for a Symbol (from R2)
    async getAuditTrail(env, symbol, limit = 100) {
        try {
            const key = `audit/${symbol}.json`;
            const obj = await env.SSSAHAM_EMITEN.get(key);
            if (!obj) return [];

            const data = await obj.json();
            if (!data || !Array.isArray(data.entries)) return [];

            // Return most recent first, limited
            return data.entries.slice(-limit).reverse();
        } catch (e) {
            console.error(`Error getting audit trail for ${symbol}:`, e);
            return [];
        }
    },

    // Helper: Record Audit Trail Entry (to R2)
    async recordAuditTrail(env, stockCode, dataDate, action, status, source) {
        const key = `audit/${stockCode}.json`;
        let history = [];

        try {
            const existing = await env.SSSAHAM_EMITEN.get(key);
            if (existing) {
                history = await existing.json();
            }
        } catch (e) { }

        // Add new entry
        // Add new entry
        const entry = {
            timestamp: new Date().toISOString(),
            date: new Date().toISOString().split('T')[0], // Job run date
            data_date: dataDate,
            action,
            status,
            source
        };

        history.push(entry);

        // Keep last 100 entries (Increased from 50)
        if (history.length > 100) history = history.slice(-100);

        // Update Audit File in R2
        await env.SSSAHAM_EMITEN.put(key, JSON.stringify(history), {
            httpMetadata: { contentType: "application/json" }
        });

        // P0 Feature: Log to D1 for monitoring
        try {
            if (env.SSSAHAM_DB) {
                const d1Status = status === 'SUCCESS' ? 'SCRAPE_SUCCESS' : 'SCRAPE_FAILED';
                await env.SSSAHAM_DB.prepare(
                    "INSERT INTO scraping_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)"
                ).bind(
                    entry.timestamp,
                    stockCode,
                    dataDate,
                    d1Status,
                    0 // Duration placeholder
                ).run();
            }
        } catch (e) {
            // Non-blocking error
            console.error(`Failed to log D1 audit for ${stockCode}:`, e);
        }
    },

    // Helper: Scrape Logo (Stockbit -> R2, no resize)
    async scrapeLogo(env, symbol) {
        const targetPath = `comp-profile/logo/${symbol}.png`;

        try {
            // 1. Check if exists
            const existing = await env.SSSAHAM_EMITEN.head(targetPath);
            if (existing) {
                return { ok: true, message: "Logo already exists", path: targetPath };
            }

            // 2. Fetch from Stockbit
            const sourceUrl = `https://assets.stockbit.com/logos/companies/${symbol}.png`;
            const resp = await fetch(sourceUrl);
            if (!resp.ok) {
                return { ok: false, error: `Failed to fetch from Stockbit: ${resp.status}` };
            }
            const arrayBuffer = await resp.arrayBuffer();

            // 3. Save directly to R2 (no processing)
            await env.SSSAHAM_EMITEN.put(targetPath, arrayBuffer, {
                httpMetadata: { contentType: "image/png" }
            });

            return { ok: true, message: "Logo scraped and saved", path: targetPath };

        } catch (e) {
            return { ok: false, error: e.message };
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

    // Helper: Get All Emiten from D1 (fallback/source of truth)
    async getAllEmitenFromDB(env) {
        try {
            if (!env.SSSAHAM_DB) return [];
            console.log("DEBUG: Fetching emiten from D1...");
            // Fetch all tickers
            const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten").all();
            if (!results) return [];

            // Strip .JK suffix
            const symbols = results.map(r => r.ticker.replace(".JK", "")).filter(s => s && s.length >= 4);
            console.log(`DEBUG: Fetched ${symbols.length} emiten from D1`);
            return symbols;
        } catch (e) {
            console.error("Failed to fetch emiten from D1:", e);
            return [];
        }
    },

    // Helper: Get Watchlist from KV (with D1 Fallback/Merge)
    async getWatchlistFromKV(env) {
        let watchlist = [];
        try {
            // 1. Try KV V2 (User Curated)
            const v2 = await env.SSSAHAM_WATCHLIST.get("SSSAHAM_WATCHLIST_V2");
            if (v2) {
                watchlist = JSON.parse(v2);
            } else {
                // 2. Try Latest (Legacy)
                const latest = await env.SSSAHAM_WATCHLIST.get("LATEST");
                if (latest) {
                    const data = JSON.parse(latest);
                    watchlist = data.data || [];
                }
            }
        } catch (e) {
            console.error("KV Watchlist Error:", e);
        }

        // 3. Always merge with D1 if available (User Request: "farming db from here")
        // This ensures fully comprehensive coverage
        const dbList = await this.getAllEmitenFromDB(env);
        if (dbList.length > 0) {
            // Merge and deduplicate
            const set = new Set([...watchlist, ...dbList]);
            watchlist = Array.from(set).sort();
        }

        return watchlist;
    },

    // Helper: Backfill Active Emiten (D1 source, N days)
    async backfillActiveEmiten(env, days = 5, overwrite = false, fromDate = null) {
        const startMsg = `🚀 **Starting INIT Backfill**\nDays: ${days}\nOverwrite: ${overwrite}\nStart Date: ${fromDate || 'Today'}\nSource: D1 (Active Emiten)`;
        console.log(startMsg);
        await this.sendWebhook(env, startMsg);

        // USE THE NEW D1 HELPER (User Requested Fallback)
        const watchlist = await this.getAllEmitenFromDB(env);

        if (watchlist.length === 0) {
            await this.sendWebhook(env, "⚠️ **Backfill Aborted**: No active emiten found in D1.");
            return new Response("No active emiten found in D1. Please seed database first.", { status: 404 });
        }

        const effectiveStart = fromDate ? new Date(fromDate) : new Date();
        const tradingDays = getTradingDays(days, effectiveStart);
        let totalDispatched = 0;
        let totalSkipped = 0;
        const batchSize = 100; // Queue batch size

        // Process day by day.
        for (const date of tradingDays) {
            const messages = [];

            for (const symbol of watchlist) {
                if (!overwrite) {
                    const key = `${symbol}/${date}.json`;
                    const exists = await objectExists(env, key);
                    if (exists) {
                        totalSkipped++;
                        continue;
                    }
                }
                messages.push({ body: { symbol, date, overwrite, attempt: 0 } });
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
        // P0 Refactor: STRICTLY IPOT ONLY
        // Removed Stockbit support completely.

        for (const message of batch.messages) {
            const { symbol, date, overwrite } = message.body;

            const startTime = Date.now();
            console.log(`[Queue] Processing ${symbol} for ${date} (overwrite: ${overwrite})`);

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

                // === IPOT PATH (ONLY) ===
                const result = await this.scrapeIpotBroksum(env, {
                    symbol,
                    from: date,
                    to: date,
                    flag5: "%",
                    save: true,
                    debug: false
                });

                const resultData = await result.json();
                const status = resultData.ok !== false && !resultData.error ? "SUCCESS_IPOT" : "FAILED_IPOT";

                await env.SSSAHAM_DB.prepare("INSERT INTO scraping_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                    .bind(new Date().toISOString(), symbol, date, status, Date.now() - startTime)
                    .run();

                if (status === "FAILED_IPOT") {
                    const attempt = (message.body.attempt ?? 0);
                    if (attempt >= 2) {
                        console.error(`[Queue] Max retries for ${symbol}/${date} via IPOT`);
                        await this.sendWebhook(env, `⚠️ **IPOT Scrape Failed**\nMax retries for ${symbol} on ${date}.\nError: ${resultData.message || 'Unknown'}`);
                        message.ack();
                    } else {
                        console.log(`[Queue] Retrying ${symbol} via IPOT (attempt ${attempt + 1})`);
                        await env.SSSAHAM_QUEUE.send({ symbol, date, overwrite, attempt: attempt + 1 });
                        message.ack();
                    }
                } else {
                    console.log(`[Queue] ✅ ${symbol}/${date} scraped via IPOT`);
                    message.ack();
                }

            } catch (err) {
                console.error(`Error processing ${symbol}:`, err);
                // Portable retry for unexpected errors
                const attempt = (message.body.attempt ?? 0);
                if (attempt >= 2) {
                    console.error(`Max retries reached for ${symbol}. Dropping.`);
                    try {
                        await this.sendWebhook(env, `❌ **Queue Error**\nMax retries for ${symbol} on ${message.body.date}.\nError: ${err.message}`);
                    } catch (e) { console.error("Webhook fail", e); }
                    message.ack();
                } else {
                    console.log(`Retrying ${symbol} (attempt ${attempt + 1})`);
                    await env.SSSAHAM_QUEUE.send({ ...message.body, attempt: attempt + 1 });
                    message.ack();
                }
            }
        }
    },



    // Helper: Broker Types (Partial Map)
    getBrokerType(code) {
        const FOREIGN = new Set(["ZP", "YU", "KZ", "RX", "BK", "AK", "CS", "CG", "DB", "ML", "CC", "DX"]); // partial list
        // Stockbit types: "Asing", "Lokal", "Pemerintah" (?)
        // For now: Asing vs Lokal
        return FOREIGN.has(code) ? "Asing" : "Lokal";
    },

    // Helper: Calculate Bandar Detector
    calculateBandarDetector(brokers_buy, brokers_sell, summaryRec) {
        if (!summaryRec) return null;

        // 1. Calculate Net for all brokers
        const netMap = new Map();

        const add = (map, code, val, vol, isBuy) => {
            if (!map.has(code)) map.set(code, { val: 0n, vol: 0n });
            const r = map.get(code);
            if (isBuy) {
                r.val += BigInt(val || 0);
                r.vol += BigInt(vol || 0);
            } else {
                r.val -= BigInt(val || 0);
                r.vol -= BigInt(vol || 0);
            }
        };

        brokers_buy.forEach(b => add(netMap, b.netbs_broker_code, b.bval, b.blotv, true));
        brokers_sell.forEach(s => add(netMap, s.netbs_broker_code, s.sval, s.slotv, false));

        // 2. Sort by Net Value (Absolute? Or Signed? usually Signed for accumulation)
        // Stockbit logic: Accumulation is Top Net Buyers. Distribution is Top Net Sellers.
        // But for "Bandar Detector", we often look at Top N Net.

        const netList = Array.from(netMap.entries()).map(([code, data]) => ({
            code,
            netVal: data.val,
            netVol: data.vol
        }));

        // Sort descending by value
        netList.sort((a, b) => (a.netVal < b.netVal) ? 1 : (a.netVal > b.netVal) ? -1 : 0);

        const getStats = (n) => {
            let sumVal = 0n;
            let sumVol = 0n;
            for (let i = 0; i < n && i < netList.length; i++) {
                if (netList[i].netVal > 0n) { // Only sum positive accumulation for "Top N Buyer"? 
                    // Stockbit "Top 1" usually means "Top 1 Net Buyer"
                    sumVal += netList[i].netVal;
                    sumVol += netList[i].netVol;
                }
            }
            // For "Top Seller", we need to look at bottom of list?
            // Stockbit Bandar Detector usually shows "Top 1", "Top 3", "Top 5" of the *Dominant* side?
            // Actually Stockbit separates "Bandar Option" (Acc/Dist).

            // Let's implement simpler: Sum of Top N Net Buyers vs Sum of Top N Net Sellers?
            // Wait, standard bandar detector usually:
            // Top 3 Broker Net Buy Value vs Top 3 Broker Net Sell Value.
            // If Buy > Sell -> Acc.

            return { val: sumVal, vol: sumVol };
        }

        // Re-sort for Top Buyers (High Positive) and Top Sellers (High Negative)
        // Actually netList is sorted desc.
        // Top Buyers = netList[0..N]
        // Top Sellers = netList[end..end-N] (sorted by magnitude of neg value)

        const buyers = netList.filter(x => x.netVal > 0n);
        const sellers = netList.filter(x => x.netVal < 0n).sort((a, b) => (a.netVal > b.netVal) ? 1 : (a.netVal < b.netVal) ? -1 : 0); // Sort asc (most negative first)

        const calc = (list, n) => {
            let v = 0n, vol = 0n;
            for (let i = 0; i < n && i < list.length; i++) {
                v += (list[i].netVal < 0n ? -list[i].netVal : list[i].netVal);
                vol += (list[i].netVol < 0n ? -list[i].netVol : list[i].netVol);
            }
            return { val: v, vol: vol };
        };

        const top1B = calc(buyers, 1);
        const top3B = calc(buyers, 3);
        const top5B = calc(buyers, 5);

        const top1S = calc(sellers, 1);
        const top3S = calc(sellers, 3);
        const top5S = calc(sellers, 5);

        // Analyze Acc/Dist (Top 3 or Top 5?)
        // Simple rule: Top 5 Buy Val > Top 5 Sell Val * 1.1 -> Big Acc?
        const b5 = Number(top5B.val);
        const s5 = Number(top5S.val);

        let status = "Neutral";
        if (b5 > s5 * 1.2) status = "Big Akum";
        else if (b5 > s5 * 1.05) status = "Akumulasi";
        else if (s5 > b5 * 1.2) status = "Big Dist";
        else if (s5 > b5 * 1.05) status = "Distribusi";

        // Construct Object
        // avg: average price of total trade?
        // avg5: average price of top 5 net?

        return {
            average: summaryRec.average_price,
            value: summaryRec.total_value,
            volume: summaryRec.total_volume_shares,
            frequency: summaryRec.total_freq,
            accdist: status,
            // Custom simplified stats for now (Stockbit structure is complex sub-field "top1": { ... })
            top1: {
                bid_val: top1B.val.toString(), bid_vol: top1B.vol.toString(),
                offer_val: top1S.val.toString(), offer_vol: top1S.vol.toString()
            },
            top3: {
                bid_val: top3B.val.toString(), bid_vol: top3B.vol.toString(),
                offer_val: top3S.val.toString(), offer_vol: top3S.vol.toString()
            },
            top5: {
                bid_val: top5B.val.toString(), bid_vol: top5B.vol.toString(),
                offer_val: top5S.val.toString(), offer_vol: top5S.vol.toString()
            },
            total_buyer: buyers.length,
            total_seller: sellers.length,
        };
    },

    async scrapeIpotBroksum(env, { symbol, from, to, flag5, save, debug }) {

        const isMock = symbol.startsWith("MOCK-");
        const debugLogs = [];
        const log = (msg) => {
            if (debug || isMock) debugLogs.push(`[${new Date().toISOString().split("T")[1]}] ${msg}`);
        };

        // 1. DATE RANGE LOGIC
        const dates = [];
        try {
            let curr = new Date(from);
            const end = new Date(to || from);
            if (isNaN(curr.getTime()) || isNaN(end.getTime())) throw new Error("Invalid dates");

            while (curr <= end) {
                dates.push(curr.toISOString().split("T")[0]);
                curr.setDate(curr.getDate() + 1);
            }
            if (dates.length > 31) throw new Error("Max range 31 days");
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, message: e.message }), {
                headers: withCors({ "Content-Type": "application/json" })
            });
        }

        const IDLE_MS = parseInt(env.IPOT_IDLE_MS) || 800;
        const MAX_MS = parseInt(env.IPOT_MAX_MS) || 8000;
        const ORIGIN = env.IPOT_ORIGIN || "https://indopremier.com";
        const WS_BASE = env.IPOT_WS_HTTP_BASE || "https://ipotapp.ipot.id/socketcluster/";

        log(`Starting scrape for ${symbol} Range: ${from} to ${to || from} (${dates.length} days)`);

        // 2. CONNECT ONCE
        let handshakeAuth = null;
        let ws;

        const connectOnce = async () => {
            const headers = {
                Upgrade: "websocket",
                Connection: "Upgrade",
                Origin: ORIGIN,
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": makeWebSocketKey(),
                "User-Agent": "broksum-scrapper/1.0"
            };
            const appsession = await getIpotAppSession(env);
            const wsWss = new URL(WS_BASE);
            wsWss.searchParams.set("appsession", appsession);
            const wsHttpUrl = wsWss.toString().startsWith("wss://")
                ? "https://" + wsWss.toString().slice("wss://".length)
                : wsWss.toString().startsWith("ws://")
                    ? "http://" + wsWss.toString().slice("ws://".length)
                    : wsWss.toString();
            const resp = await fetch(wsHttpUrl, { headers });
            if (!resp.webSocket) throw new Error(`WS upgrade failed: ${resp.status}`);
            return resp.webSocket;
        };

        try {
            ws = await connectOnce();
            ws.accept();
            // Optional handshake
            try {
                const authToken = env.IPOT_AUTH_TOKEN || null;
                ws.send(JSON.stringify({ event: "#handshake", data: { authToken }, cid: 1 }));
            } catch { }
        } catch (e) {
            // P1 Fix: Auto-recover once if session is stale
            log(`WS connect failed: ${e.message}, attempting session reset...`);
            try {
                await clearIpotAppSession(env);
                ws = await connectOnce();
                ws.accept();
                try {
                    const authToken = env.IPOT_AUTH_TOKEN || null;
                    ws.send(JSON.stringify({ event: "#handshake", data: { authToken }, cid: 1 }));
                } catch { }
                log(`WS reconnect successful after session reset`);
            } catch (e2) {
                return new Response(JSON.stringify({ ok: false, message: "WS Connect Failed (after retry): " + e2.message }), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }
        }

        // 3. QUERY HELPER
        const runScrapeSide = async (side, targetDate) => {
            if (isMock) { /* ... Mock Logic omitted for brevity, assuming mock handled elsewhere or not needed for multi-date test ... */
                // Simple mock fallback
                return { records: [], meta: { mock: true } };
            }

            const cmdid = `${Date.now()}_${Math.random()}`;
            const cid = `${Date.now()}_${Math.random()}`;

            // Ensure open? Since we reuse, check state
            if (ws.readyState !== WebSocket.OPEN) throw new Error("WS Closed unexpectedly");

            const msg = {
                event: "cmd",
                data: {
                    cmdid,
                    param: {
                        service: "midata",
                        cmd: "query",
                        param: {
                            source: "datafeed",
                            index: "en_qu_top_bs",
                            args: [side, symbol, "", "%", flag5 || "%", targetDate, targetDate],
                        }
                    }
                },
                cid
            };

            ws.send(JSON.stringify(msg));

            const records = [];
            let lastAt = Date.now();
            const startAt = Date.now();
            let gotRes = false;
            let resAt = null;
            let exitReason = "UNKNOWN";

            // Temporary listener for THIS query
            const onMsg = (ev) => {
                lastAt = Date.now();
                const txt = typeof ev.data === "string" ? ev.data : "";
                if (txt === "#1") { try { ws.send("#2"); } catch { } return; }

                let j;
                try { j = JSON.parse(txt); } catch { return; }

                if (j?.data?.isAuthenticated !== undefined) handshakeAuth = j.data.isAuthenticated;

                const line = j?.data?.data?.en_qu_top_bs;
                if (j?.event === "record" && typeof line === "string") {
                    records.push(line);
                }

                if (j?.event === "res" && j?.data?.cmdid === cmdid) {
                    gotRes = true;
                    resAt = Date.now();
                }
            };

            ws.addEventListener("message", onMsg);

            const EMPTY_IDLE_MS = 1200;
            while (true) {
                const now = Date.now();
                if (now - startAt > MAX_MS) { exitReason = "MAX_MS"; break; }
                if (gotRes && resAt && (now - resAt) > 150) { exitReason = "GOT_RES"; break; }
                if (records.length > 0 && (now - lastAt) > IDLE_MS) { exitReason = "IDLE"; break; }
                if (records.length === 0 && (now - lastAt) > EMPTY_IDLE_MS) { exitReason = "EMPTY_IDLE"; break; }
                await new Promise(r => setTimeout(r, 50));
            }

            ws.removeEventListener("message", onMsg);
            return { records, meta: { exitReason } };
        };

        // 4. LOOP EXECUTION
        const batchResults = [];
        const debugMeta = [];

        // Accumulator for summary (NOT USED in Batch Mode, but kept if we need global later? No, removing.)

        try {
            try {

                // HELPER: Split line for pre-parsing
                const splitLine = (line) => {
                    let parts = line.includes("|") ? line.split("|")
                        : line.includes("^") ? line.split("^")
                            : line.split(",");
                    parts = parts.map(s => (s ?? "").trim());
                    while (parts.length > 0 && parts[0] === "") parts.shift();
                    return parts;
                };

                const isBrokerCode = (s) => /^[A-Z0-9]{2,3}$/.test(s || "");
                // P0 Fix #2: cleanInt now validates numeric input
                const cleanInt = (s) => {
                    if (s === null || s === undefined) return "";
                    const t = String(s).replace(/,/g, "").trim();
                    return /^[0-9]+$/.test(t) ? t : "";
                };

                // Val Sorter
                const valSorter = (key) => (a, b) => {
                    const aV = BigInt(a[key] || 0);
                    const bV = BigInt(b[key] || 0);
                    return (aV < bV) ? 1 : (aV > bV) ? -1 : 0;
                };

                for (const d of dates) {
                    // If mocked, skip real loop
                    if (isMock) {
                        // Mock logic omitted for brevity in batch mode unless strictly needed
                        // Minimal mock push
                        batchResults.push({ data: { from: d, broker_summary: { stock_summary: { __summary: true, raw: "MOCK" } } }, saved_key: "MOCK" });
                        break;
                    }

                    // P0 Fix #1: Sequential scraping to avoid race condition
                    const resB = await runScrapeSide("b", d);
                    await new Promise(r => setTimeout(r, 80)); // small gap to reduce interleaving
                    const resS = await runScrapeSide("s", d);

                    if (debug) debugMeta.push({ date: d, b: resB.meta, s: resS.meta });

                    // PROCESS DAILY RECORDS
                    const processDaily = (recs) => {
                        const brokers = [];
                        const summaries = [];
                        for (const r of (recs || [])) {
                            const parts = splitLine(r);
                            if (parts.length > 0 && parts[0].toUpperCase() === symbol) {
                                summaries.push({ raw: r, parts });
                            } else {
                                brokers.push(r);
                            }
                        }
                        return { brokers, summaries };
                    };

                    const bData = processDaily(resB.records);
                    const sData = processDaily(resS.records);

                    // Aggregate One Summary for this Date
                    const allDailySummaries = [...bData.summaries, ...sData.summaries];
                    let bestSum = null;
                    let maxVal = -1n;

                    for (const s of allDailySummaries) {
                        const val = BigInt(s.parts[1]?.replace(/,/g, "") || "0");
                        if (val > maxVal) { maxVal = val; bestSum = s; }
                    }

                    // Prepare Daily Summary Rec
                    let avgPrice = "0";
                    let dailySummaryRec = null;

                    if (bestSum) {
                        const tv = BigInt(cleanInt(bestSum.parts[1]) || "0");
                        const tvol = BigInt(cleanInt(bestSum.parts[2]) || "0");
                        const freq = BigInt(cleanInt(bestSum.parts[3]) || "0");

                        if (tvol > 0n) avgPrice = (tv / tvol).toString();

                        dailySummaryRec = {
                            __summary: true,
                            stock_code: symbol,
                            total_value: tv.toString(),
                            total_volume_shares: tvol.toString(),
                            total_freq: freq.toString(),
                            average_price: avgPrice,
                            raw: bestSum.raw
                        };
                    } else {
                        // Fallback empty if no summary found
                        dailySummaryRec = {
                            __summary: true,
                            stock_code: symbol,
                            total_value: "0",
                            total_volume_shares: "0",
                            total_freq: "0",
                            average_price: "0",
                            raw: ""
                        };
                    }

                    // Process Brokers (Bidirectional Merge)
                    const rawBrokers = [...bData.brokers, ...sData.brokers];
                    const uniqueBrokers = Array.from(new Set(rawBrokers));
                    const brokerMap = new Map();

                    const parseRecord = (line) => {
                        let parts = splitLine(line);
                        // P0 Fix #2: need at least 6 parts because we access [4] & [5]
                        if (parts.length < 6) return null;
                        if (!isBrokerCode(parts[0])) return null;
                        return {
                            broker: parts[0],
                            bval: cleanInt(parts[1]) || "0",
                            bvol: cleanInt(parts[2]) || "0",
                            sval: cleanInt(parts[4]) || "0",
                            svol: cleanInt(parts[5]) || "0",
                            raw: line
                        };
                    };

                    for (const line of uniqueBrokers) {
                        const p = parseRecord(line);
                        if (!p) continue;
                        if (brokerMap.has(p.broker)) {
                            const ex = brokerMap.get(p.broker);
                            const add = (a, b) => (BigInt(a) + BigInt(b)).toString();
                            ex.bval = add(ex.bval, p.bval);
                            ex.bvol = add(ex.bvol, p.bvol);
                            ex.sval = add(ex.sval, p.sval);
                            ex.svol = add(ex.svol, p.svol);
                        } else {
                            brokerMap.set(p.broker, p);
                        }
                    }

                    // Format Final Lists
                    const brokers_buy = [];
                    const brokers_sell = [];

                    const formatSide = (rec, side) => {
                        const valStr = side === 'buy' ? rec.bval : rec.sval;
                        const volStr = side === 'buy' ? rec.bvol : rec.svol;
                        if (volStr === "0") return null;

                        let lotStr = "0", vol100 = "0", avg = "0";
                        try {
                            const vSh = BigInt(volStr);
                            const l = vSh / 100n;
                            lotStr = l.toString();
                            vol100 = (l * 100n).toString();
                            const v = BigInt(valStr);
                            if (vSh > 0n) avg = (v / vSh).toString();
                        } catch { }

                        const ymd = d.replace(/-/g, "");
                        const type = this.getBrokerType(rec.broker);

                        const common = {
                            netbs_broker_code: rec.broker,
                            netbs_date: ymd,
                            netbs_stock_code: symbol,
                            type: type
                        };

                        if (side === 'buy') {
                            return { ...common, blot: lotStr, blotv: vol100, bval: valStr, bvalv: valStr, netbs_buy_avg_price: avg };
                        } else {
                            return { ...common, slot: lotStr, slotv: vol100, sval: valStr, svalv: valStr, netbs_sell_avg_price: avg };
                        }
                    };

                    for (const rec of brokerMap.values()) {
                        const b = formatSide(rec, 'buy'); if (b) brokers_buy.push(b);
                        const s = formatSide(rec, 'sell'); if (s) brokers_sell.push(s);
                    }

                    brokers_buy.sort(valSorter('bval'));
                    brokers_sell.sort(valSorter('sval'));

                    // Calculate Bandar Detector
                    const bandarDetector = this.calculateBandarDetector(brokers_buy, brokers_sell, dailySummaryRec);

                    // Construct Output (Stockbit-compatible Schema)
                    const dailyOutput = {
                        message: "Successfully retrieved market detector data (IPOT Proxy)",
                        data: {
                            from: d,
                            to: d,
                            bandar_detector: bandarDetector,
                            broker_summary: {
                                symbol: symbol,
                                // P0 Fix #3: Include stock_summary for downstream compatibility
                                stock_summary: dailySummaryRec,
                                brokers_buy,
                                brokers_sell
                            }
                        }
                    };

                    // Meta / Debug
                    if (debug) {
                        dailyOutput._meta = {
                            source: "ipot",
                            summary: dailySummaryRec, // Moved from data.broker_summary
                            integrity_check: (() => {
                                const sum = (arr, key) => arr.reduce((acc, x) => acc + BigInt(x[key] || 0), 0n).toString();
                                const totalBuyVal = sum(brokers_buy, 'bval');
                                const summaryVal = dailySummaryRec.total_value;
                                return {
                                    calculated_buy_val: totalBuyVal,
                                    summary_val: summaryVal,
                                    delta_val: (BigInt(summaryVal) - BigInt(totalBuyVal)).toString(),
                                    match_likely: (BigInt(summaryVal) - BigInt(totalBuyVal)) < 100000000n
                                };
                            })()
                        };
                    }

                    // Save to R2
                    if (save) {
                        const key = `${symbol}/${d}.json`;
                        await env.RAW_BROKSUM.put(key, JSON.stringify(dailyOutput), {
                            httpMetadata: { contentType: "application/json" }
                        });
                        if (debug || save) dailyOutput.saved_key = key;

                        // Record Audit Trail
                        await this.recordAuditTrail(env, symbol, d, "SCRAPE_BROKSUM", "SUCCESS", "IPOT");
                    }

                    batchResults.push(dailyOutput);

                    // Breath
                    await new Promise(r => setTimeout(r, 50));
                }

            } finally {
                try { ws.close(1000, "done"); } catch { }
            }

            // RESPONSE LOGIC
            // If single day result (and asked for single day or just happened to be 1), return standard
            // But strict single day check: from == to or dates.length == 1
            if (dates.length === 1 && batchResults.length > 0) {
                return new Response(JSON.stringify(batchResults[0]), {
                    headers: withCors({ "Content-Type": "application/json" })
                });
            }

            // Batch Report (Custom Schema)
            return new Response(JSON.stringify({
                message: "Batch scrape successful",
                data: {
                    mode: "batch_range",
                    count: batchResults.length,
                    from: from,
                    to: to,
                    results: batchResults.map(r => ({
                        date: r.data.from,
                        integrity: r._meta?.integrity_check
                    }))
                }
            }), {
                headers: withCors({ "Content-Type": "application/json" })
            });

        } catch (e) {
            // ALWAYS return 200 for /ipot/scrape (pipeline data - downstream prefers predictable)
            // Error details in message + error field (no ok:false)
            return new Response(JSON.stringify({
                message: "IPOT scrape failed",
                error: e.message,
                stack: e.stack,
                debug_logs: debugLogs.slice(-100)
            }), {
                status: 200,
                headers: withCors({ "Content-Type": "application/json" })
            });
        }
    },



};
