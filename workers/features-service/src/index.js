/**
 * @worker features-service
 * @objective Calculates stock indicators and features (e.g., Smart Money Flow, Z-Score) on a schedule and manages aggregation of these features.
 *
 * @endpoints
 * - GET /aggregate -> Trigger feature aggregation manually (internal)
 * - GET /trigger-all -> Trigger calculation for all tickers (internal)
 *
 * @triggers
 * - http: yes
 * - cron: yes (Scheduled calculations)
 * - queue: FEATURES_QUEUE (Producer)
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: R2/D1 (implied for feature data)
 * - writes: Queue (FEATURES_QUEUE)
 *
 * @relations
 * - upstream: Data Sources (R2/Broksum)
 * - downstream: Feature Consumers (API/Dashboard)
 *
 * @success_metrics
 * - Calculation latency
 * - Queue dispatch success
 *
 * @notes
 * - Dispatches jobs to a queue for distributed processing.
 */
import { SmartMoney } from './smart-money';

export default {
    async scheduled(event, env, ctx) {
        // CRON HANDLER
        // 11:30 -> Dispatch Logic (Calculate)
        // 11:45 -> Aggregation Logic (Aggregate)

        const cron = event.cron;
        console.log(`Cron Triggered: ${cron}`);

        const date = new Date().toISOString().split("T")[0]; // Today (UTC)

        // 1. Dispatch Job (Calculations) - 11:30 UTC
        if (cron === "30 11 * * 1-5" || cron === "30 11 * * *") {
            await this.dispatchJobs(env, date);
        }

        // 2. Aggregation Job - 11:45 UTC
        else if (cron === "45 11 * * 1-5" || cron === "45 11 * * *") {
            await this.aggregateDaily(env, date);
        }

        // Fallback for manual test trigger (unknown cron)
        else {
            console.log("Unknown cron, running Dispatch...");
            await this.dispatchJobs(env, date);
        }
    },

    async dispatchJobs(env, date) {
        console.log(`Dispatching Feature Calculation Jobs for ${date}...`);

        let tickers = [];
        try {
            // Updated to strip .JK just in case
            const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten WHERE status = 'ACTIVE'").all();
            if (results) tickers = results.map(r => r.ticker.replace(/\.JK$/, ''));
        } catch (e) {
            console.error("Error fetching tickers:", e);
            return;
        }

        if (tickers.length === 0) {
            console.log("No tickers found.");
            return;
        }

        const messages = tickers.map(t => ({
            body: { ticker: t, date }
        }));

        // Batch send
        const batchSize = 50;
        for (let i = 0; i < messages.length; i += batchSize) {
            const chunk = messages.slice(i, i + batchSize);
            await env.FEATURES_QUEUE.sendBatch(chunk);
        }

        console.log(`Dispatched ${messages.length} jobs.`);
    },

    async fetch(req, env) {
        const url = new URL(req.url);

        // Manual Trigger for Aggregation
        if (url.pathname === "/aggregate") {
            const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
            await this.aggregateDaily(env, date);
            return new Response("Aggregation triggered");
        }

        if (url.pathname === "/trigger-all") {
            // Manual trigger for Cron logic
            const date = url.searchParams.get("date");
            await this.scheduled({ date }, env, null);
            return new Response(`Triggered all for ${date || "TODAY"}`);
        }

        // Feature Rebuild (Backfill History)
        if (url.pathname === "/rebuild-history") {
            const ticker = url.searchParams.get("ticker");
            if (!ticker) return new Response("Missing ticker param", { status: 400 });

            // Safety: If ticker="ALL", we might need to dispatch to queue instead.
            // For now, allow single ticker rebuild.

            console.log(`Rebuilding history for ${ticker}...`);

            // 1. List all raw files
            // Pattern: raw-broksum/[ticker]/[date].json OR [symbol]/[date].json
            // We need to know the prefix. broksum-scrapper uses `${symbol}/${date}.json`

            let objects = [];
            let cursor;
            try {
                do {
                    const listed = await env.RAW_BROKSUM.list({
                        prefix: `${ticker}/`,
                        cursor: cursor
                    });
                    objects.push(...listed.objects);
                    cursor = listed.cursor;
                } while (cursor);
            } catch (e) {
                return new Response(`Error listing R2: ${e.message}`, { status: 500 });
            }

            if (objects.length === 0) return new Response(`No raw data found for ${ticker}`, { status: 404 });

            // Sort by Date (filenames have date)
            objects.sort((a, b) => a.key.localeCompare(b.key));

            console.log(`Found ${objects.length} raw files.`);

            // 2. Process Sequentially
            const engine = new SmartMoney();
            let history = [];

            for (const obj of objects) {
                // key format: TICKER/YYYY-MM-DD.json
                const parts = obj.key.split('/');
                const filename = parts[parts.length - 1];
                const date = filename.replace('.json', '');

                const rawObj = await env.RAW_BROKSUM.get(obj.key);
                if (!rawObj) continue;
                const rawData = await rawObj.json();

                const processed = engine.processSingleDay(ticker, date, rawData, history);
                if (processed) {
                    history.push(processed);
                    // Keep window size
                    if (history.length > 365) history.shift();
                }
            }

            // 3. Save Result
            const historyKey = `features/z_score/emiten/${ticker}.json`;
            const finalData = { ticker, history };
            await env.SSSAHAM_EMITEN.put(historyKey, JSON.stringify(finalData));

            return new Response(JSON.stringify({
                message: `Rebuilt history for ${ticker}`,
                days_processed: objects.length,
                final_history_len: history.length
            }), { headers: { "Content-Type": "application/json" } });
        }

        return new Response("Features Service OK");
    },

    async queue(batch, env) {
        for (const msg of batch.messages) {
            const { ticker, date } = msg.body;
            console.log(`Processing ${ticker} for ${date}`);

            try {
                // 1. Fetch History (R2: features/z_score/emiten/[ticker].json)
                const historyKey = `features/z_score/emiten/${ticker}.json`;
                let historyData = { ticker, history: [] };

                const historyObj = await env.SSSAHAM_EMITEN.get(historyKey);
                if (historyObj) {
                    historyData = await historyObj.json();
                }

                // 2. Fetch Latest Raw Data (R2: raw-broksum/[ticker]/[date].json)
                // Note: The raw data key might vary. `broksum-scrapper` saves as `${symbol}/${date}.json` in RAW_BROKSUM
                const rawKey = `${ticker}/${date}.json`;
                const rawObj = await env.RAW_BROKSUM.get(rawKey);

                if (!rawObj) {
                    console.log(`No raw data for ${ticker} on ${date}`);
                    msg.ack();
                    continue;
                }

                const rawData = await rawObj.json();

                // 3. Process Logic
                const engine = new SmartMoney();
                const processed = engine.processSingleDay(ticker, date, rawData, historyData.history);

                if (processed) {
                    // Update History
                    // Remove if exists (re-run)
                    historyData.history = historyData.history.filter(h => h.date !== date);
                    historyData.history.push(processed);

                    // Sort by Date
                    historyData.history.sort((a, b) => new Date(a.date) - new Date(b.date));

                    // Keep last 365 days
                    if (historyData.history.length > 365) {
                        historyData.history = historyData.history.slice(-365);
                    }

                    // Save History back to R2
                    await env.SSSAHAM_EMITEN.put(historyKey, JSON.stringify(historyData));

                    // 4. Insert to D1 (Staging)
                    const z20 = processed.z_scores["20"] || {};
                    await env.SSSAHAM_DB.prepare(`
                        INSERT INTO daily_features (date, ticker, state, score, z_effort, z_result, z_ngr, z_elas, metrics_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(date, ticker) DO UPDATE SET
                            state=excluded.state,
                            score=excluded.score,
                            z_effort=excluded.z_effort,
                            z_result=excluded.z_result,
                            z_ngr=excluded.z_ngr,
                            z_elas=excluded.z_elas,
                            metrics_json=excluded.metrics_json,
                            created_at=excluded.created_at
                    `).bind(
                        date,
                        ticker,
                        processed.state,
                        processed.internal_score,
                        z20.effort || 0,
                        z20.result || 0,
                        z20.ngr || 0,
                        z20.elas || 0,
                        JSON.stringify(processed.z_scores),
                        new Date().toISOString()
                    ).run();

                    // 5. Log Execution (Audit)
                    await env.SSSAHAM_DB.prepare("INSERT INTO feature_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                        .bind(new Date().toISOString(), ticker, date, "FEATURE_CALC_SUCCESS", 0) // Duration not tracked precisely here
                        .run();
                }

                msg.ack();
            } catch (e) {
                console.error(`Error processing ${ticker}:`, e);
                msg.retry();
            }
        }
    },

    async aggregateDaily(env, date) {
        // Read D1 -> Write R2 Daily
        const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM daily_features WHERE date = ?").bind(date).all();

        if (!results || results.length === 0) return;

        const items = results.map(r => {
            const z = JSON.parse(r.metrics_json || "{}");

            // Minify keys for frontend
            const zMin = {};
            for (const w of Object.keys(z)) {
                zMin[w] = {
                    e: parseFloat(z[w].effort?.toFixed(2)),
                    r: parseFloat(z[w].result?.toFixed(2)),
                    n: parseFloat(z[w].ngr?.toFixed(2))
                    // Elas omitted from table json to save space? User asked for 5,10,20,60.
                    // The requirement: "z_scores_5, z_scores_10..."
                };
            }

            return {
                t: r.ticker,
                s: r.state,
                sc: r.score,
                z: zMin
            };
        });

        const dailyJson = {
            date: date,
            generated_at: new Date().toISOString(),
            items: items
        };

        const key = `features/z_score/daily/${date}.json`;
        await env.SSSAHAM_EMITEN.put(key, JSON.stringify(dailyJson));

        // Update pointer instead of full file
        const pointer = {
            date: date,
            pointer_to: key,
            generated_at: new Date().toISOString()
        };
        await env.SSSAHAM_EMITEN.put(`features/latest.json`, JSON.stringify(pointer));

        console.log(`Aggregated ${items.length} items to ${key} (Pointer updated)`);
    }
};
