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
        // 1. Dispatch Job (Calculations) - 11:30 UTC
        // Match "30 11" regardless of day-of-week part
        if (cron.includes("30 11")) {
            // Differentiate between 11:30 (Job) and 11:45 (Agg)
            if (cron.includes("30 11")) await this.dispatchJobs(env, date);
        }

        // 2. Aggregation Job - 11:45 UTC
        else if (cron.includes("45 11")) {
            await this.aggregateDaily(env, date);
        }

        // 3. Footprint Hybrid Aggregator (Periodic)
        // Match "*/" to capture periodic schedules regardless of interval
        else if (cron.includes("*/")) {
            await this.aggregateFootprint(env, date);
        }

        // Fallback or explicit trigger
        else {
            console.log(`Unknown cron ${cron}, checking alternates...`);
            // Integrity Scan (3 hours)
            if (cron.includes("*/3")) {
                await this.startIntegrityScan(env);
            }
        }
    },

    async aggregateFootprint(env, date, hour_override, url) {
        // If hour_override is provided, use it.
        // If not provided, and date is TODAY, use current hour?
        // Actually, user wants "Snapshot" behavior by default.
        // If running for PAST date, we should probably return ALL data (hour=undefined).
        // If running for TODAY, we might want "up to now"?
        // But for simplicity and fixing the bug: Let's default to UNDEFINED (No Limit) unless explicitly asked.
        // The Cron job calls this without arguments. Does cron want "Up to now"? Yes.
        // But Cron runs via `scheduled` -> `aggregateFootprint(env, date)`.
        // So for Cron, we DO want "current hour" (or just full day? Full day is safer/simpler).
        // If we aggregate "Full Day so far", it's fine.
        // So let's remove the "force current hour" logic and just pass hour_override.

        return this.aggregateHybrid(env, date, hour_override, url);
    },

    async aggregateHybrid(env, date, hour, url) {
        try {
            console.log(`Starting Hybrid Footprint Aggregation (v3.1-merged) for ${date} hour ${hour}...`);
            const startTime = Date.now();

            const forceR2 = url ? (new URL(url).searchParams.get('source') === 'r2') : false;
            let footprintData = await this.fetchFootprintAggregates(env, date, hour, forceR2);

            // Filter Invalid Tickers
            footprintData = footprintData.filter(fp => this.isValidTicker(fp.ticker));
            console.log(`Step 1: Fetched ${footprintData.length} footprint items (Hour: ${hour})`);

            // 2. Fetch Context Data (ALL emiten with z-score)
            const contextData = await this.fetchLatestContext(env, date);
            console.log(`Step 2: Fetched ${contextData.length} context items (z-score)`);

            const contextMap = new Map();
            contextData.forEach(c => contextMap.set(c.ticker, c));

            // Create footprint lookup for quick access
            const footprintMap = new Map();
            footprintData.forEach(fp => footprintMap.set(fp.ticker, fp));

            // 3. MERGE: Union of footprint + context tickers
            const allTickers = new Set([
                ...footprintData.map(fp => fp.ticker),
                ...contextData.map(c => c.ticker).filter(t => this.isValidTicker(t))
            ]);
            console.log(`Step 3: Merged ticker set = ${allTickers.size} unique tickers`);

            // 4. Calculate hybrid items for ALL tickers
            const items = [];
            let withFootprint = 0;
            let zscoreOnly = 0;

            for (const ticker of allTickers) {
                const fp = footprintMap.get(ticker);
                const ctx = contextMap.get(ticker);
                const ctxFound = !!ctx;

                if (fp) {
                    // HAS FOOTPRINT: Full hybrid calculation
                    const item = this.calculateHybridItem(fp, ctx, ctxFound);
                    if (item) {
                        item.src = 'FULL';  // Source indicator
                        items.push(item);
                        withFootprint++;
                    }
                } else if (ctx) {
                    // ZSCORE ONLY: Create item from context data
                    const item = this.calculateZscoreOnlyItem(ticker, ctx);
                    if (item) {
                        item.src = 'ZSCORE';  // Source indicator
                        items.push(item);
                        zscoreOnly++;
                    }
                }
            }

            console.log(`Step 4: Generated ${items.length} items (${withFootprint} full, ${zscoreOnly} zscore-only)`);

            // 5. Sort by Score Descending
            items.sort((a, b) => (b.sc || 0) - (a.sc || 0));

            // 6. Validate Data Quality
            const validation = this.validateHybridData(items);
            validation.with_footprint = withFootprint;
            validation.zscore_only = zscoreOnly;

            // 7. Save to R2
            const output = {
                version: 'v3.1-merged',
                generated_at: new Date().toISOString(),
                date: date,
                hour: hour,
                count: items.length,
                status: items.length > 0 ? "OK" : "DEGRADED",
                reason: items.length > 0 ? null : "NO_DATA",
                duration_ms: Date.now() - startTime,
                validation: validation,
                items: items
            };

            await env.SSSAHAM_EMITEN.put('features/footprint-summary.json', JSON.stringify(output));
            console.log(`Saved Merged Summary (v3.1) with ${items.length} items (${withFootprint} full + ${zscoreOnly} zscore-only)`);

            return output;
        } catch (err) {
            console.error("Hybrid Aggregation CRITICAL FAILURE:", err);
            await env.SSSAHAM_EMITEN.put('debug/hybrid_crash.txt', `Date: ${date}\nError: ${err.message}\nStack: ${err.stack}`);
            throw err;
        }
    },

    async fetchFootprintAggregates(env, date, limitHour, forceR2 = false) {
        // Calculate max timestamp for this hour.
        // date = "2026-02-04".
        // limitHour (UTC). e.g. 3 (10:00 WIB).

        // If limitHour is near end of day (e.g. > 9 UTC / 16 WIB), ignore limit.
        // Or strictly follow it.

        let timeFilter = "";
        if (limitHour !== undefined && limitHour < 23) { // Simple guard
            // Convert Date + Hour to Timestamp?
            // Complex in SQL.
            // Easier: time_key is unix millis.
            // We can reconstruct the limit TS in JS.
            // date is "YYYY-MM-DD". Limit to end of hour.
            // hour=3 (UTC) -> 03:59:59 UTC?
            // AADI start 02:00 UTC. So hour=3 should include it.
            // Let's ensure date parsing is UTC.
            const limitDate = new Date(`${date}T00:00:00Z`);
            limitDate.setUTCHours(limitHour + 1, 0, 0, 0);
            const limitTs = limitDate.getTime();

            console.log(`Debug filter: date=${date}, hour=${limitHour}, LimitTS=${limitTs}`);

            timeFilter = `AND time_key < ${limitTs}`;
        }

        // Step A: Get Aggregates & Time Boundaries (Single Scan)
        const { results } = await env.SSSAHAM_DB.prepare(`
            SELECT 
                ticker,
                SUM(vol) as total_vol,
                SUM(delta) as total_delta,
                MIN(time_key) as first_time,
                MAX(time_key) as last_time,
                MAX(high) as high,
                MIN(low) as low
            FROM temp_footprint_consolidate
            WHERE date = ? ${timeFilter}
            GROUP BY ticker
        `).bind(date).all();

        if (forceR2) {
            console.log(`[FORCE-R2] R2 source explicitly requested for ${date}.`);
            return await this.fetchFootprintFromR2(env, date, []);  // Empty excludeList = probe all
        }

        if (!results || results.length === 0) {
            console.log(`[D1-EMPTY] No footprint data in D1 for ${date}. Using R2 fallback...`);
            return await this.fetchFootprintFromR2(env, date, []);  // Empty excludeList = probe all
        }

        // D1 has some data - use it and SUPPLEMENT from R2 only for missing tickers
        const d1Tickers = results.map(r => r.ticker);
        console.log(`[D1-DATA] Found ${d1Tickers.length} tickers in D1 for ${date}`);

        // Supplement from R2 only for tickers NOT in D1 (budget-friendly)
        const r2Supplement = await this.fetchFootprintFromR2(env, date, d1Tickers);
        console.log(`[R2-SUPPLEMENT] Found ${r2Supplement.length} additional tickers from R2`);

        console.log("DEBUG: Raw D1 Aggregation Item [0]:", JSON.stringify(results[0]));

        // Step B: Enrich D1 data with OHLC
        const enriched = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < results.length; i += BATCH_SIZE) {
            const chunk = results.slice(i, i + BATCH_SIZE);
            const enrichedChunk = await this.enrichWithOHLC(env, chunk);
            enriched.push(...enrichedChunk);
        }

        // Step C: Merge D1 enriched + R2 supplement
        const merged = [...enriched, ...r2Supplement];
        console.log(`[MERGED] D1(${enriched.length}) + R2(${r2Supplement.length}) = ${merged.length} total footprint items`);
        
        return merged;
    },

    async enrichWithOHLC(env, chunk) {
        // Construct query to get stats for these specific time keys
        const conditions = chunk.map(r => `(ticker = '${r.ticker}' AND time_key IN (${r.first_time}, ${r.last_time}))`).join(" OR ");

        // Safety check for empty chunk
        if (!conditions) return chunk;

        const { results } = await env.SSSAHAM_DB.prepare(`
            SELECT ticker, time_key, open, close
            FROM temp_footprint_consolidate
            WHERE ${conditions}
        `).all();

        // Map results for O(1) lookup
        // Key: `${ticker}:${time_key}`
        const lookup = new Map();
        results.forEach(r => {
            lookup.set(`${r.ticker}:${r.time_key}`, r);
        });

        // Map results back to chunk
        return chunk.map(row => {
            // Direct O(1) access instead of .filter()
            const openRow = lookup.get(`${row.ticker}:${row.first_time}`);
            const closeRow = lookup.get(`${row.ticker}:${row.last_time}`);

            // Fallbacks
            const open = openRow ? openRow.open : (closeRow ? closeRow.open : 0);
            const close = closeRow ? closeRow.close : (openRow ? openRow.close : 0);

            return {
                ...row,
                open,
                close
            };
        });
    },

    /**
     * R2 Fallback: Read pre-aggregated state files from R2 when D1 is empty.
     * Uses processed/{ticker}/state.json (written by real-time pipeline).
     * Falls back to reading raw hourly files for a limited set of tickers.
     * @param {Array<string>} excludeTickers - Tickers to skip (already in D1)
     */
    async fetchFootprintFromR2(env, date, excludeTickers = []) {
        const [y, m, d] = date.split("-");
        const excludeSet = new Set(excludeTickers);

        // PRIMARY: Use emiten table as master list (R2.list is unreliable/incomplete)
        let targetTickers = [];
        try {
            const { results } = await env.SSSAHAM_DB.prepare(
                "SELECT ticker FROM emiten"  // No status filter - get ALL tickers
            ).all();
            if (results) {
                targetTickers = results
                    .map(r => r.ticker.replace(/\.JK$/, ''))
                    .filter(t => this.isValidTicker(t) && !excludeSet.has(t));
            }
            console.log(`[R2-FALLBACK] Using ${targetTickers.length} tickers from emiten (excluded ${excludeSet.size} D1 tickers)`);
        } catch (e) {
            console.warn("[R2-FALLBACK] Cannot get tickers from emiten table:", e.message);
        }

        // Fallback: R2 list only if emiten query fails
        if (targetTickers.length === 0 && excludeSet.size === 0) {
            try {
                let allPrefixes = [];
                let cursor = undefined;
                let pages = 0;
                do {
                    const opts = { prefix: "footprint/", delimiter: "/", limit: 1000 };
                    if (cursor) opts.cursor = cursor;
                    const listed = await env.TAPE_DATA_SAHAM.list(opts);
                    allPrefixes.push(...(listed.delimitedPrefixes || []));
                    cursor = listed.truncated ? listed.cursor : undefined;
                    pages++;
                } while (cursor && pages < 10);
                targetTickers = allPrefixes.map(p => p.split("/")[1]).filter(t => this.isValidTicker(t));
                console.log(`[R2-FALLBACK] Fallback: Listed ${targetTickers.length} tickers from R2`);
            } catch (e) {
                console.warn("[R2-FALLBACK] R2 list also failed");
            }
        }

        // If no tickers to probe (all excluded), return empty
        if (targetTickers.length === 0) {
            console.log(`[R2-FALLBACK] No tickers to probe (all in D1 or empty)`);
            return [];
        }

        console.log(`[R2-FALLBACK] Checking ${targetTickers.length} tickers for date ${date}`);

        // === MULTI-HOUR DISCOVERY STRATEGY ===
        // Goal: Maximize ticker coverage within 1000 R2 read budget.
        // Trading hours in UTC: 02 (09:00 WIB) through 09 (16:00 WIB)
        // Strategy: Probe peak hour first, then other hours for unfound tickers.
        // Now that we exclude D1 tickers (~158), we only probe ~615 tickers.

        const PARALLEL = 50;
        const tickerDataMap = new Map(); // ticker -> candles[]
        const MAX_READS = 900; // Leave margin from 1000 limit
        let totalReads = 0;

        // With D1 exclusion, targetTickers should be small enough (~615)
        // But limit anyway for safety
        const probeTickers = targetTickers.slice(0, Math.min(targetTickers.length, MAX_READS - 100));
        console.log(`[R2-FALLBACK] Will probe ${probeTickers.length} tickers`);

        // Round 1: Probe peak hour (03 = 10:00 WIB) for tickers
        const PEAK_HOUR = "03";
        for (let i = 0; i < probeTickers.length && totalReads < MAX_READS; i += PARALLEL) {
            const batch = probeTickers.slice(i, Math.min(i + PARALLEL, probeTickers.length));
            const remaining = MAX_READS - totalReads;
            if (remaining < batch.length) break;
            
            await Promise.all(batch.map(async (ticker) => {
                totalReads++;
                const key = `footprint/${ticker}/1m/${y}/${m}/${d}/${PEAK_HOUR}.jsonl`;
                try {
                    const obj = await env.TAPE_DATA_SAHAM.get(key);
                    if (!obj) return;
                    const text = await obj.text();
                    const candles = [];
                    for (const line of text.split("\n")) {
                        if (!line.trim()) continue;
                        try { const c = JSON.parse(line); if (c.ohlc && c.t0) candles.push(c); } catch (_) { }
                    }
                    if (candles.length > 0) tickerDataMap.set(ticker, candles);
                } catch (_) { }
            }));
        }

        console.log(`[R2-FALLBACK] Probed hour ${PEAK_HOUR}: ${tickerDataMap.size} tickers found from ${probeTickers.length} probes. Reads: ${totalReads}`);

        // Skip Round 2: Multi-hour discovery uses too much budget.
        // Tickers not found at peak hour will fallback to ZSCORE-only in the merge phase.

        console.log(`[R2-FALLBACK] Discovery complete: ${tickerDataMap.size} tickers found. Total reads: ${totalReads}/${MAX_READS}`);

        // Phase 3: Build aggregated results
        const enriched = [];
        const d1BackfillRows = [];

        for (const [ticker, candles] of tickerDataMap) {
            if (candles.length === 0) continue;
            candles.sort((a, b) => a.t0 - b.t0);

            // Deduplicate by t0
            const seen = new Set();
            const unique = candles.filter(c => {
                if (seen.has(c.t0)) return false;
                seen.add(c.t0);
                return true;
            });

            // Collect for D1 backfill
            for (const c of unique) {
                d1BackfillRows.push({
                    ticker, date, time_key: c.t0,
                    open: c.ohlc.o, high: c.ohlc.h, low: c.ohlc.l, close: c.ohlc.c,
                    vol: c.vol || 0, delta: c.delta || 0
                });
            }

            enriched.push({
                ticker,
                total_vol: unique.reduce((s, c) => s + (c.vol || 0), 0),
                total_delta: unique.reduce((s, c) => s + (c.delta || 0), 0),
                first_time: unique[0].t0,
                last_time: unique[unique.length - 1].t0,
                high: Math.max(...unique.map(c => c.ohlc.h)),
                low: Math.min(...unique.map(c => c.ohlc.l)),
                open: unique[0].ohlc.o,
                close: unique[unique.length - 1].ohlc.c
            });
        }

        console.log(`[R2-FALLBACK] Aggregated ${enriched.length} tickers (${d1BackfillRows.length} candle rows)`);

        // Phase 4: Backfill D1 (best effort, chunked)
        if (d1BackfillRows.length > 0) {
            const CHUNK = 5;
            let backfilled = 0;
            for (let i = 0; i < Math.min(d1BackfillRows.length, 2000); i += CHUNK) {
                const chunk = d1BackfillRows.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
                const vals = chunk.flatMap(v => [v.ticker, v.date, v.time_key, v.open, v.high, v.low, v.close, v.vol, v.delta]);
                try {
                    await env.SSSAHAM_DB.prepare(
                        `INSERT OR REPLACE INTO temp_footprint_consolidate (ticker, date, time_key, open, high, low, close, vol, delta) VALUES ${placeholders}`
                    ).bind(...vals).run();
                    backfilled += chunk.length;
                } catch (e) {
                    if (i === 0) console.error("[R2-BACKFILL] D1 write error:", e.message);
                }
            }
            console.log(`[R2-BACKFILL] Wrote ${backfilled}/${d1BackfillRows.length} rows to D1`);
        }

        return enriched;
    },

    async fetchLatestContext(env, date) {
        // Find latest date with data up to and including 'date'
        // Changed from < to <= to include same-day data
        const dateRow = await env.SSSAHAM_DB.prepare(`
            SELECT MAX(date) as ctx_date FROM daily_features WHERE date <= ?
        `).bind(date).first();

        const ctxDate = dateRow?.ctx_date;
        if (!ctxDate) return [];
        
        console.log(`[Context] Using z-score data from ${ctxDate} for footprint date ${date}`);

        const { results } = await env.SSSAHAM_DB.prepare(`
            SELECT ticker, state as hist_state, z_ngr as hist_z_ngr
            FROM daily_features
            WHERE date = ?
        `).bind(ctxDate).all();

        return results || [];
    },

    normalize(value, min, max) {
        const clamped = Math.max(min, Math.min(max, value));
        return (clamped - min) / (max - min);
    },

    /**
     * Calculate Divergence Factor based on Z-Score state vs intraday signal
     * 
     * Logic: If historical state conflicts with intraday direction, apply penalty
     * - DISTRIBUTION + Bullish intraday = RETAIL TRAP (0.5 penalty)
     * - ACCUMULATION + Bearish intraday = SHAKEOUT (0.7 penalty)
     * - Perfect confluence = BOOST (1.2)
     * 
     * @param {string} zScoreState - 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL' | 'TRANSITION'
     * @param {number} intradayDelta - deltaPct from footprint
     * @param {number} histZNgr - Historical Z-Score NGR (proxy for SM direction)
     * @returns {number} Factor between 0.5 and 1.2
     */
    getDivergenceFactor(zScoreState, intradayDelta, histZNgr = 0) {
        const intradayBullish = intradayDelta > 5;  // Significant positive delta (>5%)
        const intradayBearish = intradayDelta < -5; // Significant negative delta
        const smDistributing = histZNgr < -0.5;     // Z-NGR negative = SM outflow
        const smAccumulating = histZNgr > 0.5;      // Z-NGR positive = SM inflow
        
        // Case 1: DISTRIBUTION + Intraday Bullish = RETAIL TRAP
        // SM has been distributing, but today shows buying = likely retail buying the distribution
        if (zScoreState === 'DISTRIBUTION' && intradayBullish) {
            return 0.5;  // 50% penalty - HIGH RISK
        }
        
        // Case 2: Strong Distribution signal + any bullish (even moderate)
        if (zScoreState === 'DISTRIBUTION' && intradayDelta > 0 && smDistributing) {
            return 0.6;  // 40% penalty - Moderate-High risk
        }
        
        // Case 3: ACCUMULATION + Intraday Bearish = SHAKEOUT
        // SM accumulating but price down today = could be shakeout or early accumulation
        if (zScoreState === 'ACCUMULATION' && intradayBearish) {
            return 0.7;  // 30% penalty - MODERATE RISK (could be shakeout)
        }
        
        // Case 4: PERFECT CONFLUENCE - SM accumulating AND intraday bullish
        if (zScoreState === 'ACCUMULATION' && intradayBullish && smAccumulating) {
            return 1.2;  // 20% BOOST - CONFIRMED ACCUMULATION
        }
        
        // Case 5: Good confluence - Accumulation + positive delta (moderate)
        if (zScoreState === 'ACCUMULATION' && intradayDelta > 0 && smAccumulating) {
            return 1.1;  // 10% boost
        }
        
        // Case 6: DISTRIBUTION + Bearish = Confirmed Distribution (let it through, base score handles)
        if (zScoreState === 'DISTRIBUTION' && intradayBearish) {
            return 1.0;  // No adjustment, signals agree
        }
        
        // Case 7: TRANSITION state - uncertain, slight penalty if bullish
        if (zScoreState === 'TRANSITION' && intradayBullish) {
            return 0.9;  // 10% penalty - uncertain state
        }
        
        // Default: NEUTRAL state or no clear signal
        return 1.0;
    },

    isValidTicker(t) {
        if (!t) return false;
        if (t.length > 4) return false;           // Discard Warrants/Rights (long tickers)
        if (!/^[A-Z0-9]{2,4}$/.test(t)) return false; // Strict Regex
        return true;
    },

    getSignal(score, deltaPct, histZNGR, histState, pricePct) {
        // Priority 0: Safety - Falling Knife Check
        if (pricePct < -5) return 'SELL'; // Even with high delta, crashing price is dangerous

        // Priority 1: Strong Buy (Accum + Score + Stable Price)
        if (score > 0.7 && histState === 'ACCUMULATION' && pricePct >= -2) return 'STRONG_BUY';

        // Priority 2: Trap Warning (High Effort, Low Context)
        if (deltaPct > 80 && histZNGR < -0.5) return 'TRAP_WARNING';

        // Priority 3: Hidden Accum (Low Effort, Strong Context)
        if (deltaPct < 40 && histZNGR > 0.7 && histState === 'ACCUMULATION') return 'HIDDEN_ACCUM';

        // Priority 4: Strong Sell
        if (score < 0.3 && histState === 'DISTRIBUTION') return 'STRONG_SELL';

        // Default Ranges
        if (score > 0.6 && pricePct >= -3) return 'BUY';
        if (score < 0.4) return 'SELL';
        return 'NEUTRAL';
    },

    calculateHybridItem(footprint, context, ctxFound) {
        const open = footprint.open || 0;
        const close = footprint.close || 0;
        const vol = footprint.total_vol || 0;
        const delta = footprint.total_delta || 0;

        if (vol === 0 || open === 0) return null;

        // Metrics
        const deltaPct = (delta / vol) * 100;
        const pricePct = ((close - open) / open) * 100;

        // Normalization
        const hist_z_ngr = context?.hist_z_ngr ?? 0;
        const normZNGR = this.normalize(hist_z_ngr, -3, 3);
        const normDelta = this.normalize(deltaPct, -100, 100);

        // BASE Hybrid Score (before divergence adjustment)
        let baseScore = (0.3 * normZNGR) + (0.7 * normDelta);

        // Price Penalty: If price is falling hard (>4%), penalize the hybrid score
        if (pricePct < -4) {
            baseScore *= 0.5; // Cut score in half for falling knives
        } else if (pricePct >= -1 && pricePct <= 2) {
            baseScore *= 1.1; // Bonus for Sweet Spot (Consolidation)
        }
        baseScore = Math.min(1, baseScore);

        // Historical Context
        const hist_state = context?.hist_state || 'NEUTRAL';

        // === DIVERGENCE SCORING (NEW) ===
        // Calculate divergence factor based on state vs intraday signal
        const divFactor = ctxFound ? this.getDivergenceFactor(hist_state, deltaPct, hist_z_ngr) : 1.0;
        
        // Apply divergence factor to get final score
        let hybridScore = baseScore * divFactor;
        hybridScore = Math.max(0, Math.min(1, hybridScore)); // Clamp 0-1

        // Determine if this is a divergence warning situation
        const hasDivergenceWarning = divFactor < 0.8;
        
        // Determine divergence type for signal classification
        let divType = null;
        if (divFactor <= 0.5) {
            divType = 'RETAIL_TRAP';
        } else if (divFactor <= 0.7 && hist_state === 'DISTRIBUTION') {
            divType = 'SM_DIVERGENCE';
        } else if (divFactor <= 0.7 && hist_state === 'ACCUMULATION') {
            divType = 'SHAKEOUT';
        }

        // Signal (now considers divergence)
        let signal = this.getSignalWithDivergence(hybridScore, deltaPct, hist_z_ngr, hist_state, pricePct, divFactor, divType);

        // FALLBACK: If Context Missing or Neutral, but Intraday is Strong -> WATCH_ACCUM
        if (!ctxFound || hist_state === 'NEUTRAL') {
            if (normDelta > 0.8 && hybridScore > 0.6 && pricePct >= -3) signal = 'WATCH_ACCUM';
        }

        // Volatility Metrics
        const range = (footprint.high || 0) - (footprint.low || 0);
        const fluctuation = footprint.low > 0 ? (range / footprint.low) * 100 : 0;

        // Prediction: CVD-Price Divergence (Absorption Score)
        // High Delta + Low Price Chg = High Absorption (Potential Breakout)
        const divScore = Math.abs(deltaPct) / (1 + Math.abs(pricePct));

        return {
            t: footprint.ticker,
            d: parseFloat(deltaPct.toFixed(2)),
            p: parseFloat(pricePct.toFixed(2)),
            v: vol,
            h: footprint.high,
            l: footprint.low,
            r: range,
            f: parseFloat(fluctuation.toFixed(2)),
            div: parseFloat(divScore.toFixed(2)),

            ctx_found: ctxFound, // Telemetry
            ctx_net: parseFloat(hist_z_ngr.toFixed(2)),
            ctx_st: hist_state,

            // Scoring (Updated with divergence)
            sc_raw: parseFloat(baseScore.toFixed(3)),    // Raw score before divergence
            sc: parseFloat(hybridScore.toFixed(3)),       // Final score after divergence
            div_factor: parseFloat(divFactor.toFixed(2)), // Divergence factor applied
            div_warn: hasDivergenceWarning,               // Boolean flag for UI
            div_type: divType,                            // Type of divergence if any
            sig: signal
        };
    },

    /**
     * Calculate item from Z-Score data only (no footprint/intraday data)
     * Used for emiten that have historical z-score but no trading data today
     */
    calculateZscoreOnlyItem(ticker, context) {
        const hist_z_ngr = context?.hist_z_ngr ?? 0;
        const hist_state = context?.hist_state || 'NEUTRAL';

        // Normalize Z-NGR to 0-1 scale
        const normZNGR = this.normalize(hist_z_ngr, -3, 3);
        
        // Score based purely on z-score (scaled down - less confidence without intraday)
        let score = normZNGR * 0.6;  // Max 0.6 without intraday data
        score = Math.max(0, Math.min(1, score));

        // Signal based on z-score state
        let signal = 'NO_INTRADAY';
        if (hist_state === 'ACCUMULATION' && hist_z_ngr > 0.5) {
            signal = hist_z_ngr > 1.0 ? 'WATCH_ACCUM' : 'WATCH';
        } else if (hist_state === 'DISTRIBUTION' && hist_z_ngr < -0.5) {
            signal = hist_z_ngr < -1.0 ? 'STRONG_SELL' : 'SELL';
        } else if (hist_state === 'ACCUMULATION') {
            signal = 'WATCH';
        } else if (hist_state === 'DISTRIBUTION') {
            signal = 'SELL';
        }

        return {
            t: ticker,
            d: 0,          // No delta (no intraday)
            p: 0,          // No price change (no intraday)
            v: 0,          // No volume (no intraday)
            h: 0,
            l: 0,
            r: 0,
            f: 0,
            div: 0,

            ctx_found: true,
            ctx_net: parseFloat(hist_z_ngr.toFixed(2)),
            ctx_st: hist_state,

            sc_raw: parseFloat(score.toFixed(3)),
            sc: parseFloat(score.toFixed(3)),
            div_factor: 1.0,
            div_warn: false,
            div_type: null,
            sig: signal
        };
    },

    /**
     * Enhanced signal classification that considers divergence
     */
    getSignalWithDivergence(score, deltaPct, histZNGR, histState, pricePct, divFactor, divType) {
        // Priority 0: Safety - Falling Knife Check
        if (pricePct < -5) return 'SELL';

        // Priority 0.5: Divergence Warnings (NEW)
        // If severe divergence detected, override other signals
        if (divType === 'RETAIL_TRAP') {
            return 'RETAIL_TRAP';  // New signal type
        }
        
        if (divType === 'SM_DIVERGENCE' && score > 0.4) {
            return 'SM_DIVERGENCE';  // Warn about divergence even if score looks okay
        }

        // Priority 1: Strong Buy (Accum + Score + Stable Price) - now requires good divergence
        if (score > 0.7 && histState === 'ACCUMULATION' && pricePct >= -2 && divFactor >= 1.0) {
            return 'STRONG_BUY';
        }

        // Priority 1.5: Confirmed Accumulation (good score + perfect confluence)
        if (score > 0.6 && divFactor >= 1.1 && histState === 'ACCUMULATION') {
            return 'CONFIRMED_ACCUM';  // New signal - highest confidence
        }

        // Priority 2: Trap Warning (High Effort, Low Context)
        if (deltaPct > 80 && histZNGR < -0.5) return 'TRAP_WARNING';

        // Priority 3: Hidden Accum (Low Effort, Strong Context)
        if (deltaPct < 40 && histZNGR > 0.7 && histState === 'ACCUMULATION') return 'HIDDEN_ACCUM';

        // Priority 4: Strong Sell
        if (score < 0.3 && histState === 'DISTRIBUTION') return 'STRONG_SELL';

        // Default Ranges (adjusted for divergence)
        if (score > 0.6 && pricePct >= -3 && divFactor >= 0.9) return 'BUY';
        if (score > 0.5 && pricePct >= -3 && divFactor >= 0.7) return 'WATCH';  // Downgrade if divergence
        if (score < 0.4) return 'SELL';
        
        return 'NEUTRAL';
    },

    validateHybridData(items) {
        return {
            total: items.length,
            missing_context: items.filter(i => !i.ctx_found).length,
            divergence_warnings: items.filter(i => i.div_warn).length,
            signals: {
                CONFIRMED_ACCUM: items.filter(i => i.sig === 'CONFIRMED_ACCUM').length,
                STRONG_BUY: items.filter(i => i.sig === 'STRONG_BUY').length,
                BUY: items.filter(i => i.sig === 'BUY').length,
                WATCH: items.filter(i => i.sig === 'WATCH').length,
                WATCH_ACCUM: items.filter(i => i.sig === 'WATCH_ACCUM').length,
                HIDDEN_ACCUM: items.filter(i => i.sig === 'HIDDEN_ACCUM').length,
                TRAP_WARNING: items.filter(i => i.sig === 'TRAP_WARNING').length,
                RETAIL_TRAP: items.filter(i => i.sig === 'RETAIL_TRAP').length,
                SM_DIVERGENCE: items.filter(i => i.sig === 'SM_DIVERGENCE').length,
                NO_INTRADAY: items.filter(i => i.sig === 'NO_INTRADAY').length,
                NEUTRAL: items.filter(i => i.sig === 'NEUTRAL').length,
                SELL: items.filter(i => i.sig === 'SELL').length,
                STRONG_SELL: items.filter(i => i.sig === 'STRONG_SELL').length
            },
            divergence_types: {
                RETAIL_TRAP: items.filter(i => i.div_type === 'RETAIL_TRAP').length,
                SM_DIVERGENCE: items.filter(i => i.div_type === 'SM_DIVERGENCE').length,
                SHAKEOUT: items.filter(i => i.div_type === 'SHAKEOUT').length
            },
            data_sources: {
                FULL: items.filter(i => i.src === 'FULL').length,
                ZSCORE: items.filter(i => i.src === 'ZSCORE').length
            }
        };
    },

    async dispatchJobs(env, date) {
        console.log(`Dispatching Feature Calculation Jobs for ${date}...`);

        let tickers = [];
        try {
            // Get ALL tickers regardless of status
            const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten").all();
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

    async fetch(req, env, ctx) {
        try {
            const url = new URL(req.url);

            // Manual Trigger for Aggregation
            if (url.pathname === "/aggregate") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                await this.aggregateDaily(env, date);
                return new Response("Aggregation triggered");
            }

            if (url.pathname === "/aggregate-footprint") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                const isDebug = url.searchParams.get("debug") === "1";
                const hourParam = url.searchParams.get("hour");
                const hour = hourParam ? parseInt(hourParam) : undefined;
                const result = await this.aggregateFootprint(env, date, hour, req.url);
                return Response.json(result);
            }

            // Diagnostic: Count R2 tickers with data for a date
            if (url.pathname === "/diag/r2-coverage") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                const [y, mo, dy] = date.split("-");
                const hours = ["02","03","04","05","06","07","08","09"];

                // List ALL tickers from R2 prefix (paginated)
                let allPrefixes = [];
                let cursor = undefined;
                let pages = 0;
                do {
                    const opts = { prefix: "footprint/", delimiter: "/", limit: 1000 };
                    if (cursor) opts.cursor = cursor;
                    const listed = await env.TAPE_DATA_SAHAM.list(opts);
                    allPrefixes.push(...(listed.delimitedPrefixes || []));
                    cursor = listed.truncated ? listed.cursor : undefined;
                    pages++;
                } while (cursor && pages < 5);

                const tickers = allPrefixes.map(p => p.split("/")[1]).filter(t => t && /^[A-Z0-9]{2,4}$/.test(t));

                // Probe hour 03 for a sample
                const sample = tickers.slice(0, 200);
                const tickerSet = new Set();
                const batch = 50;
                for (let i = 0; i < sample.length; i += batch) {
                    const chunk = sample.slice(i, i + batch);
                    await Promise.all(chunk.map(async (t) => {
                        const obj = await env.TAPE_DATA_SAHAM.head(`footprint/${t}/1m/${y}/${mo}/${dy}/03.jsonl`);
                        if (obj) tickerSet.add(t);
                    }));
                }

                return Response.json({
                    date, total_r2_prefixes: allPrefixes.length,
                    valid_tickers: tickers.length,
                    sample_probed: sample.length,
                    found_at_hour_03: tickerSet.size,
                    sample_found: Array.from(tickerSet).slice(0, 30),
                    sample_not_found: sample.filter(t => !tickerSet.has(t)).slice(0, 30)
                });
            }

            if (url.pathname === "/trigger-all") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                // Use ctx.waitUntil to prevent premature timeout
                ctx.waitUntil(this.runDailyNow(env, date));
                return new Response(`Triggered daily pipeline (Async) for ${date}`);
            }

            // DIAGNOSTIC: Check emiten count and daily_features status
            if (url.pathname === "/diag/status") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                
                // Count ALL emiten (no status filter)
                const emitenResult = await env.SSSAHAM_DB.prepare("SELECT COUNT(*) as count FROM emiten").first();
                
                // Count daily_features for today
                const featuresResult = await env.SSSAHAM_DB.prepare("SELECT COUNT(*) as count FROM daily_features WHERE date = ?").bind(date).first();
                
                // Count UNIQUE tickers for today
                const uniqueTodayResult = await env.SSSAHAM_DB.prepare("SELECT COUNT(DISTINCT ticker) as unique_count FROM daily_features WHERE date = ?").bind(date).first();
                
                // Check for duplicates on this date
                const dupeResult = await env.SSSAHAM_DB.prepare(`
                    SELECT ticker, COUNT(*) as cnt FROM daily_features 
                    WHERE date = ? GROUP BY ticker HAVING cnt > 1 LIMIT 10
                `).bind(date).all();
                
                // Get latest date in daily_features
                const latestResult = await env.SSSAHAM_DB.prepare("SELECT MAX(date) as latest_date, COUNT(DISTINCT ticker) as unique_tickers FROM daily_features").first();
                
                // Count raw-broksum files for today - list with prefix
                let broksum_count = 0;
                let broksum_sample = [];
                try {
                    const listed = await env.RAW_BROKSUM.list({ limit: 100 });
                    // Check which ones match today's date
                    for (const obj of listed.objects) {
                        if (obj.key.includes(`/${date}.json`)) {
                            broksum_count++;
                            if (broksum_sample.length < 5) broksum_sample.push(obj.key);
                        }
                    }
                } catch (e) {
                    broksum_sample = [`Error: ${e.message}`];
                }

                return Response.json({
                    date,
                    emiten: {
                        total_count: emitenResult?.count || 0
                    },
                    daily_features: {
                        today_count: featuresResult?.count || 0,
                        today_unique: uniqueTodayResult?.unique_count || 0,
                        duplicates: dupeResult?.results || [],
                        latest_date: latestResult?.latest_date,
                        all_unique_tickers: latestResult?.unique_tickers || 0
                    },
                    raw_broksum: {
                        today_files: broksum_count,
                        sample: broksum_sample
                    }
                });
            }

            // DIAGNOSTIC: List R2 broksum contents
            if (url.pathname === "/diag/broksum-list") {
                const prefix = url.searchParams.get("prefix") || "";
                const limit = parseInt(url.searchParams.get("limit") || "50");
                
                const listed = await env.RAW_BROKSUM.list({ prefix, limit });
                return Response.json({
                    truncated: listed.truncated,
                    count: listed.objects.length,
                    objects: listed.objects.map(o => ({ key: o.key, size: o.size }))
                });
            }

            // DIAGNOSTIC: Check temp_footprint_consolidate (D1 intraday data)
            if (url.pathname === "/diag/footprint-d1") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                
                const countResult = await env.SSSAHAM_DB.prepare(
                    "SELECT COUNT(*) as total, COUNT(DISTINCT ticker) as unique_tickers FROM temp_footprint_consolidate WHERE date = ?"
                ).bind(date).first();
                
                const sampleResult = await env.SSSAHAM_DB.prepare(
                    "SELECT ticker, COUNT(*) as candles FROM temp_footprint_consolidate WHERE date = ? GROUP BY ticker ORDER BY candles DESC LIMIT 20"
                ).bind(date).all();
                
                return Response.json({
                    date,
                    total_rows: countResult?.total || 0,
                    unique_tickers: countResult?.unique_tickers || 0,
                    sample: sampleResult?.results || []
                });
            }

            // DIAGNOSTIC: Check specific ticker footprint in TAPE_DATA_SAHAM R2
            if (url.pathname === "/diag/footprint-check") {
                const ticker = url.searchParams.get("ticker") || "PTBA";
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                const [y, mo, dy] = date.split("-");
                const hours = ["02","03","04","05","06","07","08","09"];
                
                const results = {};
                for (const h of hours) {
                    const key = `footprint/${ticker}/1m/${y}/${mo}/${dy}/${h}.jsonl`;
                    const obj = await env.TAPE_DATA_SAHAM.head(key);
                    results[h] = obj ? { exists: true, size: obj.size } : { exists: false };
                }
                
                // Also check if ticker is in R2 list
                const listed = await env.TAPE_DATA_SAHAM.list({ prefix: `footprint/${ticker}/`, limit: 10 });
                
                return Response.json({
                    ticker, date,
                    hours: results,
                    r2_list: listed.objects.map(o => o.key).slice(0, 10),
                    r2_prefixes: listed.delimitedPrefixes || []
                });
            }

            // DIAGNOSTIC: Count files for specific date (paginated)
            if (url.pathname === "/diag/broksum-count") {
                const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                
                let count = 0;
                let tickers = [];
                let cursor = undefined;
                let pages = 0;
                
                do {
                    const opts = { limit: 1000 };
                    if (cursor) opts.cursor = cursor;
                    const listed = await env.RAW_BROKSUM.list(opts);
                    
                    for (const obj of listed.objects) {
                        if (obj.key.endsWith(`/${date}.json`)) {
                            count++;
                            const ticker = obj.key.split('/')[0];
                            if (!tickers.includes(ticker)) tickers.push(ticker);
                        }
                    }
                    
                    cursor = listed.truncated ? listed.cursor : undefined;
                    pages++;
                } while (cursor && pages < 50); // Max 50 pages = 50k objects
                
                return Response.json({
                    date,
                    pages_scanned: pages,
                    files_found: count,
                    unique_tickers: tickers.length,
                    tickers: tickers.slice(0, 50) // Sample
                });
            }

            // Feature Rebuild (Backfill History) - Single Ticker
            if (url.pathname === "/rebuild-history") {
                const ticker = url.searchParams.get("ticker");
                if (!ticker) return new Response("Missing ticker param", { status: 400 });

                const result = await this.rebuildHistoryForTicker(env, ticker); // REFACTORED
                return Response.json(result);
            }

            // NEW: Batch Rebuild All
            if (url.pathname === "/rebuild-all") {
                const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten").all();  // No status filter
                if (!results) return new Response("No tickers found", { status: 404 });

                const tickers = results.map(r => r.ticker.replace(/\.JK$/, ''));
                console.log(`Dispatching ${tickers.length} rebuild jobs...`);

                // Use Queue
                const messages = tickers.map(t => ({ body: { type: "REBUILD_HISTORY", ticker: t } }));

                // Batch send 50s
                for (let i = 0; i < messages.length; i += 50) {
                    await env.FEATURES_QUEUE.sendBatch(messages.slice(i, i + 50));
                }

                return new Response(`Dispatched ${tickers.length} rebuild jobs to queue.`);
            }

            // NEW: INTEGRITY SCAN (Gaps D-1 to D-90)
            if (url.pathname === "/integrity-scan") {
                const ticker = url.searchParams.get("ticker");
                if (ticker) {
                    // Single Manual
                    const result = await this.runIntegrityCheckForTicker(env, ticker, true);
                    return Response.json(result);
                } else {
                    // Trigger Full Scan
                    ctx.waitUntil(this.startIntegrityScan(env));
                    return new Response("Integrity Scan Started (Async)");
                }
            }

            return new Response("Features Service OK");
        } catch (e) {
            return new Response(`Features Service Error: ${e.message}\n${e.stack}`, { status: 500 });
        }
    },

    async runDailyNow(env, date) {
        console.log(`Manual Trigger: Running Daily Pipeline for ${date}`);
        await this.dispatchJobs(env, date);
        await this.aggregateDaily(env, date);
        await this.aggregateFootprint(env, date); // Added to ensure Footprint Summary is updated
    },

    async queue(batch, env) {
        for (const msg of batch.messages) {

            // 1. REBUILD HISTORY JOB
            if (msg.body.type === 'REBUILD_HISTORY') {
                const { ticker } = msg.body;
                console.log(`[QUEUE] Rebuilding History for ${ticker}`);
                try {
                    await this.rebuildHistoryForTicker(env, ticker);
                    msg.ack();
                } catch (e) {
                    console.error(`[QUEUE] Rebuild Failed for ${ticker}:`, e);
                    msg.retry();
                }
                continue;
            }

            // 1.5 INTEGRITY CHECK JOB
            if (msg.body.type === 'INTEGRITY_CHECK') {
                const { ticker } = msg.body;
                try {
                    await this.runIntegrityCheckForTicker(env, ticker, true);
                    msg.ack();
                } catch (e) {
                    console.error(`[QUEUE] Integrity Check Failed for ${ticker}:`, e);
                    msg.ack(); // Don't retry integrity checks to avoid loops, just ack.
                }
                continue;
            }

            // 2. STANDARD DAILY CALCULATION JOB
            const { ticker, date } = msg.body;
            // Legacy format check: if no type, assume daily calc
            if (!date) {
                console.warn(`[QUEUE] Invalid message format`, msg.body);
                msg.ack();
                continue;
            }

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

    // EXTRACTED LOGIC
    async rebuildHistoryForTicker(env, ticker) {
        console.log(`Rebuilding history for ${ticker}...`);

        // 1. List all raw files
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
            throw new Error(`Error listing R2: ${e.message}`);
        }

        if (objects.length === 0) return { message: `No raw data found for ${ticker}`, days_processed: 0 };

        objects.sort((a, b) => a.key.localeCompare(b.key));

        // 2. Process Sequentially
        const engine = new SmartMoney();
        let history = [];

        // Optimize: Fetch concurrently using batches?
        // Risk: Memory limit if too many contents.
        // Files are small (~2KB). 365 days = ~730KB.
        // We can batch fetch.
        const BATCH_SIZE = 20;
        for (let i = 0; i < objects.length; i += BATCH_SIZE) {
            const chunk = objects.slice(i, i + BATCH_SIZE);
            // Parallel Fetch
            const responses = await Promise.all(chunk.map(obj => env.RAW_BROKSUM.get(obj.key)));
            const datas = await Promise.all(responses.map(r => r ? r.json() : null));

            for (let j = 0; j < chunk.length; j++) {
                const rawData = datas[j];
                if (!rawData) continue;

                const key = chunk[j].key;
                const filename = key.split('/').pop();
                const date = filename.replace('.json', '');

                const processed = engine.processSingleDay(ticker, date, rawData, history);
                if (processed) {
                    history.push(processed);
                    if (history.length > 365) history.shift();
                }
            }
        }

        // 3. Save Result
        const historyKey = `features/z_score/emiten/${ticker}.json`;
        const finalData = { ticker, history };
        await env.SSSAHAM_EMITEN.put(historyKey, JSON.stringify(finalData));

        // 4. Update D1 (Sync History) using Batch
        const syncHistory = history.slice(-90);
        if (syncHistory.length > 0) {
            const stmt = env.SSSAHAM_DB.prepare(`
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
            `);

            // Split into manageable chunks for D1 batch limit (approx 100 queries)
            const D1_BATCH_SIZE = 20;
            for (let k = 0; k < syncHistory.length; k += D1_BATCH_SIZE) {
                const sub = syncHistory.slice(k, k + D1_BATCH_SIZE);
                const batch = sub.map(h => {
                    const z20 = h.z_scores["20"] || {};
                    return stmt.bind(
                        h.date,
                        ticker,
                        h.state,
                        h.internal_score,
                        z20.effort || 0,
                        z20.result || 0,
                        z20.ngr || 0,
                        z20.elas || 0,
                        JSON.stringify(h.z_scores),
                        new Date().toISOString()
                    );
                });
                await env.SSSAHAM_DB.batch(batch);
            }
            console.log(`Synced ${syncHistory.length} rows to D1 for ${ticker}`);
        }

        // 5. Log Execution (Audit)
        try {
            await env.SSSAHAM_DB.prepare("INSERT INTO feature_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                .bind(new Date().toISOString(), ticker, "FULL_HISTORY", "REBUILD_SUCCESS", 0)
                .run();
        } catch (e) { console.error("Audit Log Error:", e); }

        return {
            message: `Rebuilt history for ${ticker}`,
            days_processed: objects.length,
            final_history_len: history.length
        };
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
                    n: parseFloat(z[w].ngr?.toFixed(2)),
                    el: parseFloat(z[w].elas?.toFixed(2)) // Expose Elasticity
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
        await env.SSSAHAM_EMITEN.put(key, JSON.stringify(dailyJson), {
            httpMetadata: { contentType: "application/json" }
        });

        // Update pointer instead of full file
        const pointer = {
            date: date,
            pointer_to: key,
            generated_at: new Date().toISOString()
        };
        await env.SSSAHAM_EMITEN.put(`features/latest.json`, JSON.stringify(pointer));

        console.log(`Aggregated ${items.length} items to ${key} (Pointer updated)`);
    },

    // -------------------------------------------------------------------------
    // INTEGRITY SCANNER LOGIC
    // -------------------------------------------------------------------------

    async startIntegrityScan(env) {
        console.log("Starting System-Wide Integrity Scan (D-1 to D-90)...");
        let results = [];
        try {
            const dbRes = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten").all();  // No status filter - scan ALL tickers
            results = dbRes.results;
        } catch (e) { console.error("DB Error:", e); return; }

        if (!results) return;

        // Dispatch Integrity Check Jobs to Queue
        const messages = results.map(r => ({
            body: { type: "INTEGRITY_CHECK", ticker: r.ticker.replace(/\.JK$/, '') }
        }));

        console.log(`Queueing ${messages.length} integrity checks...`);
        for (let i = 0; i < messages.length; i += 50) {
            await env.FEATURES_QUEUE.sendBatch(messages.slice(i, i + 50));
        }
    },

    async runIntegrityCheckForTicker(env, ticker, fix = true) {
        // 1. Generate Expected Dates (D-1 to D-90, Weekdays)
        const expectedDates = [];
        const now = new Date();
        now.setUTCHours(0, 0, 0, 0); // UTC Midnight

        // Start from D-1
        for (let i = 1; i <= 90; i++) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) { // Skip Sat/Sun
                expectedDates.push(d.toISOString().split('T')[0]);
            }
        }

        // 2. Load Existing Z-Score History
        let historyArray = [];
        try {
            const obj = await env.SSSAHAM_EMITEN.get(`features/z_score/emiten/${ticker}.json`);
            if (obj) {
                const data = await obj.json();
                if (data.history && Array.isArray(data.history)) {
                    historyArray = data.history;
                }
            }
        } catch (e) { /* No history */ }

        // Map existing dates
        const existingDates = new Set(historyArray.map(h => h.date));

        // 3. Find Gaps
        const missing = expectedDates.filter(d => !existingDates.has(d));

        if (missing.length === 0) {
            return { ticker, status: "OK", missing: 0 };
        }

        console.log(`[Integrity] ${ticker} missing ${missing.length} days (e.g. ${missing[0]})`);

        if (!fix) return { ticker, status: "GAPS_FOUND", missing: missing.length, dates: missing };

        // 4. Resolve Gaps (Check Raw Data)
        let rebuildQueued = false;
        const missingRaw = [];

        // LIMIT CHECK: Only check top 5 gaps to avoid massive R2 calls per job if huge gaps
        const gapsToCheck = missing.length > 30 ? missing.slice(0, 30) : missing;

        for (const date of gapsToCheck) {
            try {
                // Check R2 for Raw Data
                // Path: {ticker}/{date}.json or {ticker}/ipot/{date}.json

                let exists = await env.RAW_BROKSUM.head(`${ticker}/${date}.json`);
                if (!exists) {
                    exists = await env.RAW_BROKSUM.head(`${ticker}/ipot/${date}.json`);
                }

                if (exists) {
                    rebuildQueued = true;
                    // Found at least one date with Raw Data -> Trigger Rebuild & Stop checking (Optimization)
                    // Rebuild function re-reads folders, so it will pick up all available.
                    break;
                } else {
                    missingRaw.push(date);
                }
            } catch (e) {
                console.error("R2 Head Error:", e);
                // Assume missing
            }
        }

        // Action A: Trigger Backfill for Missing Raw
        if (missingRaw.length > 0) {
            // Log for Broksum Scanner
            console.log(`[Integrity] ${missingRaw.length} dates need RAW BACKFILL (Broksum Scanner should handle).`);
            // Optional: Call auto-backfill?
        }

        if (rebuildQueued) {
            console.log(`[Integrity] ${ticker} triggering History Rebuild.`);
            await env.FEATURES_QUEUE.send({ type: "REBUILD_HISTORY", ticker });

            // Log Integrity Check Result (Action Taken)
            try {
                await env.SSSAHAM_DB.prepare("INSERT INTO feature_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                    .bind(new Date().toISOString(), ticker, "RANGE", "INTEGRITY_REBUILD_TRIGGERED", 0)
                    .run();
            } catch (e) { console.error("Audit Log Error:", e); }

            return { ticker, status: "REBUILD_TRIGGERED" };
        }

        // Log Integrity Check Result (No Action or Missing Raw)
        try {
            await env.SSSAHAM_DB.prepare("INSERT INTO feature_logs (timestamp, symbol, date, status, duration_ms) VALUES (?, ?, ?, ?, ?)")
                .bind(new Date().toISOString(), ticker, "RANGE", missingRaw.length > 0 ? "INTEGRITY_MISSING_RAW" : "INTEGRITY_OK", 0)
                .run();
        } catch (e) { console.error("Audit Log Error:", e); }

        return { ticker, status: "MISSING_RAW", missing_count: missing.length };
    }
};
