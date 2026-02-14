export class SmartMoney {
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

    processSingleDay(ticker, dateStr, rawData, existingHistory) {
        // 1. Unpack Raw Data (Hybrid Support: IPOT vs Stockbit)
        const d = rawData.data || rawData;
        let foreign = { buy_val: 0, sell_val: 0 };
        let local = { buy_val: 0, sell_val: 0 };
        let retail = { buy_val: 0, sell_val: 0 };
        let close = 0;
        let totalValue = 0;
        let totalVolume = 0;

        // CHECK IF IPOT STRUCTURE (has broker_summary with arrays)
        if (d.broker_summary && (Array.isArray(d.broker_summary.brokers_buy) || Array.isArray(d.broker_summary.brokers_sell))) {
            const bs = d.broker_summary;

            // Extract Price (VWAP as Close Proxy)
            if (bs.stock_summary && bs.stock_summary.average_price) {
                close = parseFloat(bs.stock_summary.average_price);
            } else if (d.bandar_detector && d.bandar_detector.average) {
                close = parseFloat(d.bandar_detector.average);
            }

            // Extract Total Value & Volume for VWAP calculation
            if (bs.stock_summary) {
                totalValue = parseFloat(bs.stock_summary.total_value) || 0;
                totalVolume = parseFloat(bs.stock_summary.total_volume_shares) || 0;
            }
            if (totalValue === 0 && d.bandar_detector) {
                totalValue = parseFloat(d.bandar_detector.value) || 0;
                totalVolume = parseFloat(d.bandar_detector.volume) || 0;
            }

            // Aggregate Brokers
            const aggregate = (list, isBuy) => {
                if (!list) return;
                list.forEach(b => {
                    const val = parseFloat(isBuy ? b.bval : b.sval) || 0;
                    const type = b.type || "Lokal";
                    if (type === "Asing") {
                        if (isBuy) foreign.buy_val += val; else foreign.sell_val += val;
                    } else {
                        // All non-Asing is Local (including Retail for now)
                        if (isBuy) local.buy_val += val; else local.sell_val += val;
                    }
                });
            };

            aggregate(bs.brokers_buy, true);
            aggregate(bs.brokers_sell, false);

        } else {
            // LEGACY / STOCKBIT STRUCTURE
            const bd = d.bandar_detector || {};
            close = bd.price_close || d.close || 0;
            foreign = d.foreign || { buy_val: 0, sell_val: 0 };
            retail = d.retail || { buy_val: 0, sell_val: 0 };
            local = d.local || { buy_val: 0, sell_val: 0 };
            totalValue = parseFloat(bd.value) || 0;
            totalVolume = parseFloat(bd.volume) || 0;
        }

        const grossBuy = (foreign.buy_val || 0) + (retail.buy_val || 0) + (local.buy_val || 0);
        const grossSell = (foreign.sell_val || 0) + (retail.sell_val || 0) + (local.sell_val || 0);

        const effort = grossBuy + grossSell; // Total Volume (Value)

        // CORRECTION: Net should be Net Foreign Flow for Z_NGR?
        // Or Net Accumulation (Top N)?
        // The standard NGR metric is Net Foreign / Total Value.
        // Existing code (grossBuy - grossSell) is always 0 for market-wide data.
        // We switch to Net Foreign for valid NGR.
        const net = (foreign.buy_val || 0) - (foreign.sell_val || 0);

        // DEBUG LOGGING
        console.log(`[SmartMoney] ${ticker} ${dateStr} - F.Buy: ${foreign.buy_val}, F.Sell: ${foreign.sell_val}, Net: ${net}, Effort: ${effort}`);
        console.log(`[SmartMoney] Brokers array check: Buy=${d.broker_summary?.brokers_buy?.length}, Sell=${d.broker_summary?.brokers_sell?.length}`);

        // 2. Determine Previous Close for Return
        // We need the last entry from history
        const lastEntry = existingHistory[existingHistory.length - 1];
        const prevClose = lastEntry ? lastEntry.close : close; // If first day, ret = 0

        let ret = 0;
        if (prevClose > 0 && close > 0) {
            ret = (close - prevClose) / prevClose;
        }

        const result = Math.abs(ret);
        const ngr = effort === 0 ? 0 : Math.abs(net) / effort;
        const epsilon = 1e-9;
        const elasticity = result / (Math.abs(net) + epsilon);

        // VWAP Deviation: compare close to rolling VWAP (Σ Value / Σ Volume)
        // Daily VWAP = totalValue / totalVolume (already provided by IPOT as average_price)
        // For rolling VWAP we need cumulative value & volume over the window — stored per day
        const dailyVwap = totalVolume > 0 ? totalValue / totalVolume : close;

        const currentMetrics = {
            date: dateStr,
            close,
            metrics: { effort, result, net, ngr, elas: elasticity, ret, totalValue, totalVolume }
        };

        // 3. Build Temporary Series for Z-Score Calculation
        // combine stats from history + current
        // History items have `metrics` object.
        const fullSeries = [...existingHistory, currentMetrics];
        const n = fullSeries.length;

        // 4. Calculate Z-Scores for Windows [2, 5, 10, 20, 60]
        const z_scores = {};
        const windows = [2, 5, 10, 20, 60];

        // Need at least window size? No, calculate what we can.

        for (const w of windows) {
            const slice = fullSeries.slice(Math.max(0, n - w), n);
            if (slice.length < 2) {
                z_scores[w] = { effort: 0, result: 0, ngr: 0, elas: 0, vwap: 0 };
                continue;
            }

            // Effort Z
            const effVals = slice.map(s => s.metrics.effort);
            const effMean = effVals.reduce((a, b) => a + b, 0) / effVals.length;
            const effStd = SmartMoney.stdDev(effVals, effMean);
            const effZ = effStd === 0 ? 0 : (effort - effMean) / effStd;

            // Result Z
            const resVals = slice.map(s => s.metrics.result);
            const resMean = resVals.reduce((a, b) => a + b, 0) / resVals.length;
            const resStd = SmartMoney.stdDev(resVals, resMean);
            const resZ = resStd === 0 ? 0 : (result - resMean) / resStd;

            // NGR Z
            const ngrVals = slice.map(s => s.metrics.ngr);
            const ngrMean = ngrVals.reduce((a, b) => a + b, 0) / ngrVals.length;
            const ngrStd = SmartMoney.stdDev(ngrVals, ngrMean);
            const ngrZ = ngrStd === 0 ? 0 : (ngr - ngrMean) / ngrStd;

            // Elas Z
            const elasVals = slice.map(s => s.metrics.elas);
            const elasMean = elasVals.reduce((a, b) => a + b, 0) / elasVals.length;
            const elasStd = SmartMoney.stdDev(elasVals, elasMean);
            const elasZ = elasStd === 0 ? 0 : (elasticity - elasMean) / elasStd;

            // VWAP Deviation Z — Rolling VWAP = Σ(totalValue) / Σ(totalVolume) over window
            let vwapZ = 0;
            const sumVal = slice.reduce((s, d) => s + (d.metrics.totalValue || 0), 0);
            const sumVol = slice.reduce((s, d) => s + (d.metrics.totalVolume || 0), 0);
            const rollingVwap = sumVol > 0 ? sumVal / sumVol : 0;
            if (rollingVwap > 0 && close > 0) {
                // Compute deviation of each day's close from rolling VWAP
                const devs = slice.map(d => {
                    const c = d.close || 0;
                    return rollingVwap > 0 ? (c - rollingVwap) / rollingVwap : 0;
                });
                const currentDev = (close - rollingVwap) / rollingVwap;
                const devMean = devs.reduce((a, b) => a + b, 0) / devs.length;
                const devStd = SmartMoney.stdDev(devs, devMean);
                vwapZ = devStd === 0 ? 0 : (currentDev - devMean) / devStd;
            }

            z_scores[w] = { effort: effZ, result: resZ, ngr: ngrZ, elas: elasZ, vwap: vwapZ };
        }

        // 5. Classification (Based on Window 20)
        // Store Real Z-Scores (Actual Calculation for Day T) to ensure history integrity
        const real_z_scores = JSON.parse(JSON.stringify(z_scores));

        const primaryZ = z_scores["20"] || z_scores["10"] || { effort: 0, result: 0, elas: 0, ngr: 0 };

        // --- EFFORT SHIFT LOGIC (User Request) ---
        // Use Yesterday's Effort Z-Score if available.
        // Logic: "Did Big Money enter yesterday?" (D-1 Effort) vs "Price Stability Today" (D Result)
        let effortZ = primaryZ.effort;
        if (lastEntry) {
            // Check for real_z_scores (New Format) or fallback to z_scores (Old Format/Legacy)
            const prevZ = lastEntry.real_z_scores ? lastEntry.real_z_scores["20"] : (lastEntry.z_scores ? lastEntry.z_scores["20"] : null);

            if (prevZ) {
                effortZ = prevZ.effort; // Override with D-1
                // Also update the object that will be exposed to Frontend/DB
                if (z_scores["20"]) z_scores["20"].effort = effortZ;
                if (z_scores["10"]) z_scores["10"].effort = prevZ.effort; // Apply to 10 too for consistency? Or just used 20.
            }
        }
        // ------------------------------------------

        const resultZ = primaryZ.result;
        const elasZ = primaryZ.elas;
        const ngrZ = primaryZ.ngr;

        // Determine if effort is declining (Trend) - using effective effortZ (D-1)
        // Actually, if effortZ is D-1, then "Declining" means "D-1 Effort < D-2 Effort"?
        // Or "D-1 Effort < Average".
        // Let's stick to using effortZ as the proxy for "Current Relevant Effort".

        let effortDeclining = false;
        // Logic simplification: Effort Declining if current relevant Effort Z is negative?
        // Or strictly declining trend.
        // For D-1 logic, we just check if the Effective Effort is high or low.

        let state = 'NEUTRAL';
        const isEffortHigh = effortZ > 0.5;
        const isEffortLow = effortZ < -0.5;
        const isResultLow = resultZ < 0;

        // READY MARKUP: Effort Declining (selling pressure gone?), Price Stable (Result Low), Elasticty High (Price moves easily with little net)
        // D-1 Logic: Effort (D-1) was High, Result (D) is Stable.
        // That sounds like Accumulation. 
        // Ready Markup: Maybe Effort (D-1) Low? 
        // Let's trust the variables: `effortZ` is now D-1.

        if (effortDeclining && resultZ > -0.5 && elasticity > elasMean20 * 1.1) {
            state = 'READY_MARKUP';
        } else if (isEffortHigh && Math.abs(resultZ) < 0.5) {
            state = 'TRANSITION';
        } else if (isEffortHigh && resultZ < -0.5 && ret >= 0) {
            state = 'ACCUMULATION'; // High effort (yesterday), price stable/up (today) -> Accumulation
        } else if (isEffortHigh && ret < -0.01) {
            state = 'DISTRIBUTION'; // High effort (yesterday), price drop (today) -> Distribution
        }

        if (state === 'NEUTRAL' && isEffortLow && isResultLow) state = 'NEUTRAL';

        // 6. Internal Score
        const score = (this.W1 * effortZ) - (this.W2 * Math.abs(resultZ)) + (this.W3 * (1 - elasZ)) + (this.W4 * ngrZ);

        return {
            date: dateStr,
            close,
            metrics: currentMetrics.metrics,
            z_scores: z_scores, // Map { "5": {...}, "20": {...} } (Contains D-1 Effort)
            real_z_scores: real_z_scores, // HIDDEN: True Day T Z-Scores (For next day's D-1 lookup)
            state,
            internal_score: score
        };
    }
}
