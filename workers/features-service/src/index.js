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

        // Use last trading day instead of today's UTC date. This ensures
        // weekends/holidays still find footprint data from the previous Friday.
        let date = new Date().toISOString().split("T")[0]; // Today (UTC)
        {
            let dd = new Date(`${date}T12:00:00Z`);
            while ([0, 6].includes(dd.getUTCDay()) || (this.IDX_HOLIDAYS && this.IDX_HOLIDAYS.has(dd.toISOString().slice(0, 10)))) {
                dd = new Date(dd.getTime() - 86400000);
            }
            const tradingDate = dd.toISOString().slice(0, 10);
            if (tradingDate !== date) {
                console.log(`[scheduled] Adjusted date from ${date} (non-trading) to ${tradingDate} (last trading day)`);
                date = tradingDate;
            }
        }

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

            const prevDate = this.prevTradingDayUTC(date);
            // Fetch 20 trading-day stats + sector digest in parallel
            const [processedStatsMaps, sectorDigestMap] = await Promise.all([
                this.fetchProcessedDailyStatsMaps(env, date, 20),
                this.fetchSectorDigestMap(env, date)
            ]);
            const processedStatsMap     = processedStatsMaps[0]; // D0 = today
            const prevProcessedStatsMap = processedStatsMaps[1]; // D1 = yesterday
            console.log(`Step 2.5: processed-stats maps ${processedStatsMaps.filter(m => m.size > 0).length}/20 loaded; sector digest ${sectorDigestMap.size} symbols`);

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
                        const rawCandleCount = Number(fp?.candle_count || 0);
                        const stats = processedStatsMap.get(ticker);
                        const prevStats = prevProcessedStatsMap.get(ticker);

                        if (rawCandleCount < 30) {
                            if (stats) {
                                // S1/C2: Sparse D1 (<30 candles) — override Δ%/Mom%/Absorb with EOD processed stats.
                                // p_src switches from 'intraday' → 'overnight' (close-to-close daily return).
                                const vol = Number(stats.vol);
                                const netVol = Number(stats.netVol);
                                const close = Number(stats.close);
                                const prevClose = Number(prevStats?.close);

                                if (Number.isFinite(vol) && vol > 0 && Number.isFinite(netVol)) {
                                    const deltaPctFallback = (netVol / vol) * 100;
                                    item.d         = Number(deltaPctFallback.toFixed(2));
                                    item.net_delta = Number(netVol); // B1: keep in sync
                                    item.cvd       = item.net_delta; // B1: alias
                                }

                                if (Number.isFinite(close) && close > 0 && Number.isFinite(prevClose) && prevClose > 0) {
                                    const momPctFallback = ((close - prevClose) / prevClose) * 100;
                                    item.p = Number(momPctFallback.toFixed(2));
                                    item.p_src = 'overnight'; // C2: semantics changed — daily close-to-close, NOT intraday
                                    item.growth_pct = Number(momPctFallback.toFixed(2));
                                    item.open_price = prevClose;
                                    item.recent_price = close;
                                }

                                if (Number.isFinite(item.d) && Number.isFinite(item.p)) {
                                    item.div = Number((Math.abs(item.d) / (1 + Math.abs(item.p))).toFixed(2));
                                }

                                if (Number.isFinite(stats.freq) && stats.freq > 0) {
                                    item.freq_tx = Math.round(stats.freq);
                                }
                            } else {
                                // S1: Sparse D1 + no processed stats available (intraday, pre-EOD).
                                // Keep whatever few-candle intraday values calculateHybridItem produced
                                // but mark them as noisy so consumers can choose to hide/dim.
                                item.p_src = 'intraday_sparse';
                            }
                        }

                        // S2: ALWAYS override growth_pct with close-to-close (prevClose → curClose)
                        // when prevClose is available. This ensures GROWTH column matches standard
                        // stock app conventions (Google Finance, IPOT, etc.) regardless of candle count.
                        // NOTE: item.p (Mom%) is NOT overridden for ≥30 candle items — it retains
                        // its intraday semantics for technical scoring purposes.
                        {
                            const curClose = Number(processedStatsMap.get(ticker)?.close);
                            const prevClose = Number(prevProcessedStatsMap.get(ticker)?.close);
                            if (Number.isFinite(curClose) && curClose > 0 && Number.isFinite(prevClose) && prevClose > 0) {
                                item.open_price = prevClose;
                                item.recent_price = curClose;
                                item.growth_pct = Number((((curClose - prevClose) / prevClose) * 100).toFixed(2));
                            }
                        }
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

            // Step 4.5: Merge sector digest + CVD windows into every item
            for (const item of items) {
                const ticker = item.t;

                // Sector digest: overwrite freq_tx and growth_pct with scraper values.
                // freq_tx: sector scraper levels_sum is the most accurate tx count — always override.
                // growth_pct: sector scraper = (price_last_now - price_open_first_snapshot) / price_open.
                //   Only override when item.p_src is 'intraday' or growth_pct is still null.
                //   Do NOT override 'overnight' path — that uses processed-stats close-to-close which
                //   is more meaningful than a sparse single-snapshot growth from sector scraper.
                const digest = sectorDigestMap.get(ticker);
                if (digest) {
                    if (Number.isFinite(digest.freq_tx) && digest.freq_tx > 0) {
                        item.freq_tx  = Math.round(digest.freq_tx);
                        item.freq_src = 'sector_digest';
                    }
                    const canOverrideGrowth = item.growth_pct == null
                        || item.p_src === 'intraday'
                        || item.p_src === 'intraday_sparse';
                    if (canOverrideGrowth && Number.isFinite(digest.growth_pct)) {
                        item.growth_pct   = parseFloat(digest.growth_pct.toFixed(2));
                        item.open_price   = digest.price_open   ?? item.open_price;
                        item.recent_price = digest.price_last   ?? item.recent_price;
                    }
                }

                // CVD windows: cumulative netVol from processed stats (broksum-sourced)
                // maps[0]=D0(today, often empty intraday), maps[1]=D1, ... maps[19]=D20
                let cvd_2d = 0, cvd_5d = 0, cvd_10d = 0, cvd_20d = 0;
                let has_2d = 0, has_5d = 0, has_10d = 0, has_20d = 0;
                for (let i = 0; i < 20; i++) {
                    const nv = processedStatsMaps[i]?.get(ticker)?.netVol;
                    if (!Number.isFinite(nv)) continue;
                    if (i < 2)  { cvd_2d  += nv; has_2d++; }
                    if (i < 5)  { cvd_5d  += nv; has_5d++; }
                    if (i < 10) { cvd_10d += nv; has_10d++; }
                    cvd_20d += nv; has_20d++;
                }
                item.cvd_2d  = has_2d  ? cvd_2d  : null;
                item.cvd_5d  = has_5d  ? cvd_5d  : null;
                item.cvd_10d = has_10d ? cvd_10d : null;
                item.cvd_20d = has_20d ? cvd_20d : null;

                // RVOL windows: today_vol / avg_vol(window)
                // Use item.v (footprint candle volume) as today's volume — processedStatsMaps[0]
                // is often empty intraday because processed/{date}.json is written at EOD.
                const todayVol = item.v || processedStatsMaps[0]?.get(ticker)?.vol;
                if (Number.isFinite(todayVol) && todayVol > 0) {
                    const calcRvol = (windowSize) => {
                        let sum = 0, count = 0;
                        // Start from D1 (yesterday) to avoid including today in average
                        for (let i = 1; i <= windowSize && i < 20; i++) {
                            const v = processedStatsMaps[i]?.get(ticker)?.vol;
                            if (Number.isFinite(v) && v > 0) { sum += v; count++; }
                        }
                        if (count === 0) return null;
                        const avg = sum / count;
                        return parseFloat((todayVol / avg).toFixed(2));
                    };
                    item.rvol_2d  = calcRvol(2);
                    item.rvol_5d  = calcRvol(5);
                    item.rvol_10d = calcRvol(10);
                    item.rvol_20d = calcRvol(20);
                }
            }

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

            // PRE-MARKET GUARD: Don't overwrite a FULL summary with a zscore-only one
            // when market is closed. Between 00:00–02:00 UTC (07:00–09:00 WIB),
            // D1 has no footprint data for the new UTC date, so the cron produces
            // zscore-only output. Overwriting the previous FULL summary would cause
            // empty charts for users opening the page in the morning.
            //
            // EXCEPTION: Allow save when new output has significantly more items
            // (e.g., v3.1 adds ZSCORE-only items with CVD/RVOL windows enrichment).
            // This ensures weekend/holiday runs can enrich the summary even without
            // fresh footprint candle data, as long as we're not reducing data quality.
            if (withFootprint === 0 && zscoreOnly > 0) {
                const nowUTC = new Date();
                const hourUTC = nowUTC.getUTCHours();
                const isPreMarket = hourUTC < 2 || hourUTC >= 10; // Before 09:00 WIB or after 17:00 WIB
                if (isPreMarket) {
                    try {
                        const existingObj = await env.SSSAHAM_EMITEN.get('features/footprint-summary.json');
                        if (existingObj) {
                            const existing = await existingObj.json();
                            const existingFull = Number(existing?.validation?.with_footprint || 0);
                            const existingCount = Number(existing?.count || existing?.items?.length || 0);

                            // Allow save if new output has ≥20% more items than existing
                            // (covers v3.0→v3.1 upgrade where ZSCORE items are added).
                            // Also merge: carry forward FULL items' intraday fields from existing.
                            if (existingFull > 0 && items.length <= existingCount * 1.2) {
                                console.log(`[PRE-MARKET GUARD] Skipping save: current summary has ${existingFull} full, ${existingCount} total items, new has ${items.length}. Preserving existing.`);
                                return output; // Return but don't save
                            }

                            // New output has significantly more items — allow save but
                            // carry forward intraday fields (d, p, div, net_delta, v)
                            // from existing FULL items so we don't lose intraday quality.
                            if (existingFull > 0) {
                                const existingMap = new Map(
                                    (existing?.items || []).map(it => [String(it?.t || '').toUpperCase(), it])
                                );
                                let carried = 0;
                                for (const item of items) {
                                    const prev = existingMap.get(String(item.t || '').toUpperCase());
                                    if (!prev || prev.src === 'ZSCORE') continue;
                                    // Carry forward intraday-specific fields from existing FULL items
                                    // only if current item has zero/placeholder values
                                    if (item.d === 0 && prev.d !== 0) item.d = prev.d;
                                    if (item.p === 0 && prev.p !== 0) item.p = prev.p;
                                    if (item.div === 0 && prev.div !== 0) item.div = prev.div;
                                    if ((item.net_delta === 0 || item.net_delta == null) && prev.net_delta) {
                                        item.net_delta = prev.net_delta;
                                        item.cvd = prev.cvd ?? prev.net_delta;
                                    }
                                    if (!item.v && prev.v) item.v = prev.v;
                                    if (!item.freq_tx && prev.freq_tx) item.freq_tx = prev.freq_tx;
                                    if (item.growth_pct == null && prev.growth_pct != null) item.growth_pct = prev.growth_pct;
                                    if (!item.open_price && prev.open_price) item.open_price = prev.open_price;
                                    if (!item.recent_price && prev.recent_price) item.recent_price = prev.recent_price;
                                    if (prev.src === 'FULL') item.src = 'FULL_CARRIED';
                                    carried++;
                                }
                                console.log(`[PRE-MARKET GUARD] Merging: carried forward ${carried} FULL items' intraday data into ${items.length} new items.`);
                            }
                        }
                    } catch (e) {
                        console.warn('[PRE-MARKET GUARD] Failed to read existing summary:', e?.message);
                    }
                }
            }

            await env.SSSAHAM_EMITEN.put('features/footprint-summary.json', JSON.stringify(output));
            console.log(`Saved Merged Summary (v3.1) with ${items.length} items (${withFootprint} full + ${zscoreOnly} zscore-only)`);

            return output;
        } catch (err) {
            console.error("Hybrid Aggregation CRITICAL FAILURE:", err);
            await env.SSSAHAM_EMITEN.put('debug/hybrid_crash.txt', `Date: ${date}\nError: ${err.message}\nStack: ${err.stack}`);
            throw err;
        }
    },

    // IDX public holidays (market-closed weekdays)
    IDX_HOLIDAYS: new Set([
        // 2025
        '2025-01-01','2025-01-27','2025-01-28','2025-03-28','2025-03-31',
        '2025-04-01','2025-04-18','2025-05-01','2025-05-12','2025-05-29',
        '2025-06-01','2025-06-06','2025-06-27','2025-09-05',
        '2025-12-25','2025-12-26',
        // 2026
        '2026-01-01','2026-02-16','2026-02-17','2026-03-11','2026-03-31',
        '2026-04-01','2026-04-02','2026-04-03','2026-04-10','2026-05-01',
        '2026-05-21','2026-06-01','2026-06-08','2026-06-29','2026-08-17',
        '2026-09-08','2026-12-25','2026-12-26'
    ]),

    prevTradingDayUTC(dateStr) {
        let d = new Date(`${dateStr}T12:00:00Z`);
        do {
            d = new Date(d.getTime() - 86400000);
        } while ([0, 6].includes(d.getUTCDay()) || this.IDX_HOLIDAYS.has(d.toISOString().slice(0, 10)));
        return d.toISOString().slice(0, 10);
    },

    async fetchProcessedDailyStatsMap(env, dateStr) {
        const out = new Map();
        if (!env?.TAPE_DATA_SAHAM || !dateStr) return out;

        try {
            const obj = await env.TAPE_DATA_SAHAM.get(`processed/${dateStr}.json`);
            if (!obj) return out;

            const parsed = await obj.json();
            const items = Array.isArray(parsed)
                ? parsed
                : (Array.isArray(parsed?.items) ? parsed.items : []);

            for (const item of items) {
                const ticker = String(item?.kode || item?.t || '').toUpperCase();
                const open = Number(item?.open ?? item?.o);
                const close = Number(item?.close ?? item?.c);
                const vol = Number(item?.vol ?? item?.v);
                const netVol = Number(item?.net_vol ?? item?.nv);
                const freq = Number(item?.freq ?? item?.f);
                if (!ticker || !this.isValidTicker(ticker)) continue;
                out.set(ticker, {
                    open: Number.isFinite(open) ? open : null,
                    close: Number.isFinite(close) ? close : null,
                    vol: Number.isFinite(vol) ? vol : null,
                    netVol: Number.isFinite(netVol) ? netVol : null,
                    freq: Number.isFinite(freq) ? freq : null,
                });
            }
        } catch (e) {
            console.warn(`[R2-CLOSE] Failed to read processed/${dateStr}.json:`, e?.message || e);
        }

        return out;
    },

    /**
     * Fetch processed daily stats for N consecutive trading days in parallel.
     * Returns array where [0]=date (today), [1]=prev day, ..., [N-1]=oldest.
     */
    async fetchProcessedDailyStatsMaps(env, date, n = 20) {
        // Ensure dates[0] is always the most recent TRADING day, not a weekend/holiday.
        // This prevents processedStatsMaps[0] from being empty on non-trading days,
        // which would break RVOL calculation (todayVol = 0) and shift CVD windows.
        let startDate = date;
        {
            let sd = new Date(`${date}T12:00:00Z`);
            while ([0, 6].includes(sd.getUTCDay()) || this.IDX_HOLIDAYS.has(sd.toISOString().slice(0, 10))) {
                sd = new Date(sd.getTime() - 86400000);
            }
            startDate = sd.toISOString().slice(0, 10);
        }
        const dates = [startDate];
        let d = new Date(`${startDate}T12:00:00Z`);
        while (dates.length < n) {
            d = new Date(d.getTime() - 86400000);
            const ds = d.toISOString().slice(0, 10);
            if (![0, 6].includes(d.getUTCDay()) && !this.IDX_HOLIDAYS.has(ds)) {
                dates.push(ds);
            }
        }
        return Promise.all(dates.map(dt => this.fetchProcessedDailyStatsMap(env, dt)));
    },

    /**
     * Compute freq_tx + growth_pct digest from an array of sector tape records.
     * Ported from sector-scrapper's computeDigest() — keeps logic in one place.
     */
    computeSectorDigest(records) {
        if (!records || records.length === 0) return null;
        const sorted = [...records].sort((a, b) =>
            new Date(a.ts).getTime() - new Date(b.ts).getTime()
        );
        const first = sorted[0];
        const last  = sorted[sorted.length - 1];

        let freq_tx = null;
        if (Array.isArray(last.levels) && last.levels.length > 0) {
            freq_tx = last.levels.reduce((sum, lv) =>
                sum + (Number(lv.b_freq) || 0) + (Number(lv.s_freq) || 0), 0);
        } else if (last.freq_tx != null) {
            freq_tx = Number(last.freq_tx) || null;
        }

        const price_open = first.price_last ?? null;
        const price_last = last.price_last  ?? null;
        const price_high = last.price_high  ?? null;
        const price_low  = last.price_low   ?? null;

        let growth_pct = null;
        if (price_open != null && price_last != null && price_open !== 0) {
            growth_pct = parseFloat((((price_last - price_open) / price_open) * 100).toFixed(4));
        }

        return { freq_tx, price_open, price_last, price_high, price_low,
                 growth_pct, snapshots_count: sorted.length,
                 ts_first: first.ts, ts_last: last.ts };
    },

    /**
     * Read all 11 sector aggregate JSONL files from R2 (11 reads total).
     * Groups records by symbol, computes digest per symbol.
     * Returns Map<ticker, digest>.
     */
    async fetchSectorDigestMap(env, date) {
        const out = new Map();
        if (!env?.TAPE_DATA_SAHAM || !date) return out;

        const ALL_SECTORS = [
            'IDXBASIC','IDXENERGY','IDXINDUST','IDXNONCYC','IDXCYCLIC',
            'IDXHEALTH','IDXFINANCE','IDXPROPERT','IDXTECHNO','IDXINFRA','IDXTRANS'
        ];
        const [yyyy, mm, dd] = date.split('-');

        await Promise.allSettled(ALL_SECTORS.map(async (sector) => {
            try {
                const key = `sector/${sector}/${yyyy}/${mm}/${dd}.jsonl`;
                const obj = await env.TAPE_DATA_SAHAM.get(key);
                if (!obj) return;
                const text = await obj.text();

                // Group records by symbol within this sector file
                const bySymbol = new Map();
                for (const line of text.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const rec = JSON.parse(line);
                        const sym = String(rec?.symbol || '').toUpperCase();
                        if (!sym) continue;
                        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
                        bySymbol.get(sym).push(rec);
                    } catch { /* skip malformed line */ }
                }

                for (const [sym, records] of bySymbol.entries()) {
                    const digest = this.computeSectorDigest(records);
                    if (digest) out.set(sym, { ...digest, sector });
                }
            } catch (e) {
                console.warn(`[SECTOR-DIGEST] Failed to read sector ${sector} for ${date}:`, e?.message || e);
            }
        }));

        return out;
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
                COUNT(*) as candle_count,
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

        // D1 has some data - but some rows can be partial (e.g. only one hour from fallback backfill).
        // For such rows, replace with targeted R2 multi-hour reconstruction.
        const todayUTC = new Date().toISOString().slice(0, 10);
        const isToday = date === todayUTC;
        const fullSessionEndTs = new Date(`${date}T09:00:00Z`).getTime();
        const endCutoffTs = isToday
            ? Math.max(new Date(`${date}T02:00:00Z`).getTime(), Date.now() - (15 * 60 * 1000))
            : new Date(`${date}T08:50:00Z`).getTime();

        const d1CompleteRows = [];
        const d1IncompleteTickers = [];
        for (const row of results) {
            const lastTs = Number(row?.last_time || 0);
            const isCoverageOk = Number.isFinite(lastTs) && lastTs >= Math.min(endCutoffTs, fullSessionEndTs);
            if (isCoverageOk) {
                d1CompleteRows.push(row);
            } else {
                d1IncompleteTickers.push(String(row?.ticker || '').toUpperCase());
            }
        }

        const d1Tickers = d1CompleteRows.map(r => r.ticker);
        console.log(`[D1-DATA] Found ${results.length} tickers in D1 (${d1CompleteRows.length} complete, ${d1IncompleteTickers.length} incomplete) for ${date}`);

        // Supplement from R2 only for tickers NOT in complete D1 set (budget-friendly)
        const r2Supplement = await this.fetchFootprintFromR2(env, date, d1Tickers);
        console.log(`[R2-SUPPLEMENT] Found ${r2Supplement.length} additional tickers from R2`);

        // For incomplete D1 rows, force targeted multi-hour R2 rebuild to avoid wrong Growth/Freq/CVD.
        const r2Replacements = d1IncompleteTickers.length
            ? await this.fetchFootprintFromR2(env, date, [], d1IncompleteTickers)
            : [];
        if (d1IncompleteTickers.length) {
            console.log(`[R2-REPLACE] Rebuilt ${r2Replacements.length}/${d1IncompleteTickers.length} incomplete D1 tickers from R2`);
        }

        console.log("DEBUG: Raw D1 Aggregation Item [0]:", JSON.stringify(results[0]));

        // Step B: Enrich COMPLETE D1 data with OHLC
        const enriched = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < d1CompleteRows.length; i += BATCH_SIZE) {
            const chunk = d1CompleteRows.slice(i, i + BATCH_SIZE);
            const enrichedChunk = await this.enrichWithOHLC(env, chunk);
            enriched.push(...enrichedChunk);
        }

        // Step C: Merge D1 enriched + R2 supplement + R2 replacements (dedupe by ticker)
        const mergedMap = new Map();
        for (const row of [...enriched, ...r2Supplement, ...r2Replacements]) {
            const t = String(row?.ticker || '').toUpperCase();
            if (!t) continue;
            mergedMap.set(t, row);
        }
        const merged = Array.from(mergedMap.values());
        console.log(`[MERGED] D1(${enriched.length}) + R2-supp(${r2Supplement.length}) + R2-replace(${r2Replacements.length}) = ${merged.length} total footprint items`);

        // Prefer true transaction frequency from processed daily snapshot when available.
        const processedFreqMap = await this.fetchProcessedDailyFreqMap(env, date);
        if (processedFreqMap.size > 0) {
            for (const row of merged) {
                const t = String(row?.ticker || '').toUpperCase();
                const freq = processedFreqMap.get(t);
                if (Number.isFinite(freq) && freq > 0) {
                    row.trade_freq = Math.round(freq);
                }
            }
        }
        
        return merged;
    },

    async fetchProcessedDailyFreqMap(env, date) {
        const out = new Map();
        if (!env?.TAPE_DATA_SAHAM || !date) return out;

        try {
            const key = `processed/${date}.json`;
            const obj = await env.TAPE_DATA_SAHAM.get(key);
            if (!obj) return out;

            const parsed = await obj.json();
            const items = Array.isArray(parsed)
                ? parsed
                : (Array.isArray(parsed?.items) ? parsed.items : []);

            for (const item of items) {
                const ticker = String(item?.kode || item?.t || '').toUpperCase();
                const freq = Number(item?.freq ?? item?.f);
                if (!ticker || !this.isValidTicker(ticker)) continue;
                if (!Number.isFinite(freq) || freq <= 0) continue;
                out.set(ticker, Math.round(freq));
            }
        } catch (e) {
            console.warn(`[R2-FREQ] Failed to read processed/${date}.json:`, e?.message || e);
        }

        return out;
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
    async fetchFootprintFromR2(env, date, excludeTickers = [], targetTickersOverride = null) {
        const [y, m, d] = date.split("-");
        const excludeSet = new Set(excludeTickers);
        const isTargetedMode = Array.isArray(targetTickersOverride) && targetTickersOverride.length > 0;

        // PRIMARY: Use emiten table as master list (R2.list is unreliable/incomplete)
        let targetTickers = [];
        if (isTargetedMode) {
            const seen = new Set();
            targetTickers = targetTickersOverride
                .map(t => String(t || '').toUpperCase())
                .filter(t => this.isValidTicker(t) && !excludeSet.has(t))
                .filter(t => {
                    if (seen.has(t)) return false;
                    seen.add(t);
                    return true;
                });
            console.log(`[R2-FALLBACK] Targeted mode for ${targetTickers.length} tickers`);
        } else {
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
        }

        // Fallback: R2 list only if emiten query fails
        if (!isTargetedMode && targetTickers.length === 0 && excludeSet.size === 0) {
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

        // === R2 READ STRATEGY ===
        // - Default mode: probe only peak hour for broad coverage (budget-limited).
        // - Targeted mode: read full session hours for specific tickers (accuracy mode).

        const PARALLEL = 50;
        const tickerDataMap = new Map(); // ticker -> candles[]
        const MAX_READS = 900; // Leave margin from 1000 limit
        let totalReads = 0;

        // With D1 exclusion, targetTickers should be small enough (~615)
        // But limit anyway for safety
        const probeTickers = targetTickers.slice(0, Math.min(targetTickers.length, MAX_READS - 100));
        console.log(`[R2-FALLBACK] Will probe ${probeTickers.length} tickers`);

        const parseCandlesFromText = (text) => {
            const candles = [];
            for (const line of String(text || '').split("\n")) {
                if (!line.trim()) continue;
                try {
                    const c = JSON.parse(line);
                    if (c && c.ohlc && c.t0) candles.push(c);
                } catch (_) { }
            }
            return candles;
        };

        if (isTargetedMode) {
            const HOURS = ["02", "03", "04", "05", "06", "07", "08", "09"];
            for (let i = 0; i < probeTickers.length && totalReads < MAX_READS; i += PARALLEL) {
                const batch = probeTickers.slice(i, Math.min(i + PARALLEL, probeTickers.length));
                await Promise.all(batch.map(async (ticker) => {
                    const allCandles = [];
                    for (const hh of HOURS) {
                        if (totalReads >= MAX_READS) break;
                        totalReads++;
                        const key = `footprint/${ticker}/1m/${y}/${m}/${d}/${hh}.jsonl`;
                        try {
                            const obj = await env.TAPE_DATA_SAHAM.get(key);
                            if (!obj) continue;
                            const text = await obj.text();
                            allCandles.push(...parseCandlesFromText(text));
                        } catch (_) { }
                    }
                    if (allCandles.length > 0) tickerDataMap.set(ticker, allCandles);
                }));
            }
            console.log(`[R2-FALLBACK] Targeted full-session read found ${tickerDataMap.size}/${probeTickers.length} tickers. Reads: ${totalReads}`);
        } else {
            // Round 1: Probe peak hour (03 = 10:00 WIB) for broad fallback coverage
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
                        const candles = parseCandlesFromText(text);
                        if (candles.length > 0) tickerDataMap.set(ticker, candles);
                    } catch (_) { }
                }));
            }

            console.log(`[R2-FALLBACK] Probed peak hour found ${tickerDataMap.size}/${probeTickers.length} tickers. Reads: ${totalReads}`);
        }

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
                candle_count: unique.length,
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

        // C3: guard against zero open/close — close=0 produces Mom%=-100% which corrupts scoring
        if (vol === 0 || open === 0 || close === 0) return null;

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

        const candleCount = Number(footprint.candle_count || 0);
        const trueFreq = Number(footprint.trade_freq);
        const freqTx = Number.isFinite(trueFreq) && trueFreq > 0 ? Math.round(trueFreq) : candleCount;
        const reliableGrowth = candleCount >= 30;

        return {
            t: footprint.ticker,
            d: parseFloat(deltaPct.toFixed(2)),
            p: parseFloat(pricePct.toFixed(2)),
            p_src: 'intraday', // C2: semantic tag — open_firstCandle → close_lastCandle (intraday)
            v: vol,
            h: footprint.high,
            l: footprint.low,
            r: range,
            f: parseFloat(fluctuation.toFixed(2)),
            div: parseFloat(divScore.toFixed(2)),

            // Extended fields for frontend compatibility
            growth_pct: reliableGrowth ? parseFloat(pricePct.toFixed(2)) : null,
            freq_tx: freqTx,
            freq_src: 'D1_candle_count', // B3: source tag; overwritten to 'sector_digest' in aggregateHybrid
            net_delta: Number(delta || 0), // B1: current-day SUM(delta) — NOT cumulative
            cvd: Number(delta || 0),       // B1: alias for backward compat — will be removed next release
            open_price: reliableGrowth ? open : null,
            recent_price: reliableGrowth ? close : null,
            notional_val: (close && delta !== 0) ? Math.round(delta * close * 100) : null, // B2: net value = delta(lot)×100(lembar/lot)×price — signed (+ buy, - sell), in Rp
            nv: (close && delta !== 0) ? Math.round(delta * close * 100) : null,           // B2: alias for backward compat

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
                let date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
                // Auto-adjust to last trading day if date falls on weekend/holiday
                {
                    let dd = new Date(`${date}T12:00:00Z`);
                    while ([0, 6].includes(dd.getUTCDay()) || (this.IDX_HOLIDAYS && this.IDX_HOLIDAYS.has(dd.toISOString().slice(0, 10)))) {
                        dd = new Date(dd.getTime() - 86400000);
                    }
                    const adjusted = dd.toISOString().slice(0, 10);
                    if (adjusted !== date) {
                        console.log(`[aggregate-footprint] Adjusted date from ${date} to ${adjusted} (last trading day)`);
                        date = adjusted;
                    }
                }
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

            // FOREIGN FLOW SCANNER - Calculate and save foreign flow trend for all emiten
            if (url.pathname === "/foreign-flow-scanner") {
                const lookback = parseInt(url.searchParams.get("days") || "10");
                // Run async to avoid timeout
                ctx.waitUntil(this.calculateForeignFlowScanner(env, lookback));
                return new Response(`Foreign Flow Scanner triggered (${lookback} days lookback). Check R2 for results.`);
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
            const zWithFallback = { ...z };

            // Backward-compat: historical rows may not have 2D window.
            // If missing, derive 2D payload from 5D so frontend VWAP 2D doesn't go blank.
            if (!zWithFallback["2"] && zWithFallback["5"]) {
                zWithFallback["2"] = { ...zWithFallback["5"] };
            }

            // Minify keys for frontend
            const zMin = {};
            for (const w of Object.keys(zWithFallback)) {
                const src = zWithFallback[w] || {};
                zMin[w] = {
                    e: parseFloat(src.effort?.toFixed(2)),
                    r: parseFloat(src.result?.toFixed(2)),
                    n: parseFloat(src.ngr?.toFixed(2)),
                    el: parseFloat(src.elas?.toFixed(2)), // Expose Elasticity
                    v: parseFloat(src.vwap?.toFixed(2)) || 0 // VWAP Deviation Z
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
    },

    // -------------------------------------------------------------------------
    // FOREIGN FLOW SCANNER - Calculate foreign flow trend for all emiten
    // -------------------------------------------------------------------------
    
    /**
     * Calculate foreign flow trend for all emiten.
     * For each ticker: fetch last N days broksum, calculate cumulative foreign net & trend.
     * Save result to R2 as features/foreign-flow-scanner.json
     * 
     * @param {Object} env - Worker environment bindings
     * @param {number} lookbackDays - Number of trading days to look back (default 10)
     */
    async calculateForeignFlowScanner(env, lookbackDays = 10) {
        console.log(`[FOREIGN-FLOW] Starting scanner with ${lookbackDays} day lookback...`);
        const startTime = Date.now();

        // 1. Get all tickers from emiten table
        let tickers = [];
        try {
            const { results } = await env.SSSAHAM_DB.prepare("SELECT ticker FROM emiten").all();
            if (results) tickers = results.map(r => r.ticker.replace(/\.JK$/, '')).filter(t => this.isValidTicker(t));
        } catch (e) {
            console.error("[FOREIGN-FLOW] Failed to get tickers:", e);
            return { error: e.message };
        }

        console.log(`[FOREIGN-FLOW] Processing ${tickers.length} tickers...`);

        // 2. Generate expected dates (last N trading days)
        const tradingDates = [];
        const now = new Date();
        now.setUTCHours(0, 0, 0, 0);
        for (let i = 1; tradingDates.length < lookbackDays && i <= 30; i++) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) { // Skip weekends
                tradingDates.push(d.toISOString().split('T')[0]);
            }
        }
        tradingDates.reverse(); // Oldest first

        // 3. Foreign broker codes (asing)
        const FOREIGN_CODES = new Set(["ZP", "YU", "KZ", "RX", "BK", "AK", "CS", "CG", "DB", "ML", "CC", "DX", "FS", "LG", "NI", "OD"]);

        // 4. Process in batches to avoid hitting R2 limits
        const BATCH_SIZE = 50;
        const results = [];
        let r2Reads = 0;

        for (let batch = 0; batch < tickers.length; batch += BATCH_SIZE) {
            const batchTickers = tickers.slice(batch, batch + BATCH_SIZE);

            const batchPromises = batchTickers.map(async (ticker) => {
                // Fetch broksum data for each date
                const dailyNets = [];
                
                for (const date of tradingDates) {
                    const key = `${ticker}/${date}.json`;
                    try {
                        r2Reads++;
                        const obj = await env.RAW_BROKSUM.get(key);
                        if (!obj) continue;
                        
                        const data = await obj.json();
                        if (!data.buy || !data.sell) continue;

                        // Calculate foreign net for this day
                        let foreignBuy = 0, foreignSell = 0;
                        for (const b of data.buy) {
                            if (FOREIGN_CODES.has(b.broker)) foreignBuy += (b.val || 0);
                        }
                        for (const s of data.sell) {
                            if (FOREIGN_CODES.has(s.broker)) foreignSell += (s.val || 0);
                        }
                        const foreignNet = foreignBuy - foreignSell;
                        dailyNets.push({ date, net: foreignNet });
                    } catch (e) {
                        // Skip errors silently
                    }
                }

                if (dailyNets.length < 3) {
                    return null; // Not enough data
                }

                // Calculate cumulative values
                let cumulative = 0;
                const cumulativeValues = [];
                for (const d of dailyNets) {
                    cumulative += d.net;
                    cumulativeValues.push(cumulative);
                }

                // Calculate trend (simple linear regression slope)
                const n = cumulativeValues.length;
                const xMean = (n - 1) / 2;
                const yMean = cumulativeValues.reduce((a, b) => a + b, 0) / n;
                
                let numerator = 0, denominator = 0;
                for (let i = 0; i < n; i++) {
                    numerator += (i - xMean) * (cumulativeValues[i] - yMean);
                    denominator += (i - xMean) * (i - xMean);
                }
                const slope = denominator !== 0 ? numerator / denominator : 0;

                // Current value (latest cumulative)
                const currentValue = cumulativeValues[cumulativeValues.length - 1];
                
                // Normalize slope to daily average
                const dailySlope = slope;

                // Score: prioritize positive trend and positive current value
                // Score = (currentValue > 0 ? 1 : 0) * 2 + (slope > 0 ? 1 : 0) * 2 + normalized_slope
                const trendScore = (currentValue > 0 ? 2 : 0) + (dailySlope > 0 ? 2 : 0);
                
                return {
                    t: ticker,
                    fv: Math.round(currentValue / 1e9 * 100) / 100, // Foreign Value in Billion
                    ft: Math.round(dailySlope / 1e9 * 100) / 100,   // Foreign Trend (daily slope) in Billion
                    ts: trendScore,                                   // Trend Score (0-4)
                    days: dailyNets.length
                };
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults.filter(r => r !== null));
        }

        // 5. Sort by trend score (higher = better)
        results.sort((a, b) => {
            // Primary: trend score
            if (b.ts !== a.ts) return b.ts - a.ts;
            // Secondary: absolute trend value
            return b.ft - a.ft;
        });

        // 6. Save to R2
        const output = {
            version: 'v1.0',
            generated_at: new Date().toISOString(),
            lookback_days: lookbackDays,
            count: results.length,
            r2_reads: r2Reads,
            duration_ms: Date.now() - startTime,
            items: results
        };

        await env.SSSAHAM_EMITEN.put('features/foreign-flow-scanner.json', JSON.stringify(output), {
            httpMetadata: { contentType: "application/json" }
        });

        console.log(`[FOREIGN-FLOW] Saved ${results.length} items. R2 reads: ${r2Reads}. Duration: ${output.duration_ms}ms`);
        return output;
    }
};
