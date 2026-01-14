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
        // 1. Unpack Raw Data
        // rawData structure from broksum-scrapper: { data: { foreign: {...}, retail: {...}, local: {...}, broker_summary: {...} } }
        // We need 'close' price. rawData usually doesn't have OHLC unless we fetch it.
        // Wait, `broksum-scrapper` raw data is from `marketdetectors` endpoint which DOES NOT have OHLC usually.
        // BUT `data.bandar_detector` usually has `close` price?
        // Let's check `broksum-scrapper` logic:
        // "const currClose = d.close || (d.data && d.data.close) || 0;"

        // I need to be sure where `close` comes from.
        // `marketdetectors` endpoint returns `close` inside `data`?
        // Let's assume `data.close` or `data.bandar_detector.close`.

        const d = rawData.data || rawData;
        const bd = d.bandar_detector || {};
        const close = bd.price_close || d.close || 0; // Check data shape if fails

        // Calculate Metrics
        const foreign = d.foreign || { buy_val: 0, sell_val: 0 };
        const retail = d.retail || { buy_val: 0, sell_val: 0 };
        const local = d.local || { buy_val: 0, sell_val: 0 };

        const grossBuy = (foreign.buy_val || 0) + (retail.buy_val || 0) + (local.buy_val || 0);
        const grossSell = (foreign.sell_val || 0) + (retail.sell_val || 0) + (local.sell_val || 0);

        const effort = grossBuy + grossSell;
        const net = grossBuy - grossSell;

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

        const currentMetrics = {
            date: dateStr,
            close,
            metrics: { effort, result, net, ngr, elas: elasticity, ret }
        };

        // 3. Build Temporary Series for Z-Score Calculation
        // combine stats from history + current
        // History items have `metrics` object.
        const fullSeries = [...existingHistory, currentMetrics];
        const n = fullSeries.length;

        // 4. Calculate Z-Scores for Windows [5, 10, 20, 60]
        const z_scores = {};
        const windows = [5, 10, 20, 60];

        // Need at least window size? No, calculate what we can.

        for (const w of windows) {
            const slice = fullSeries.slice(Math.max(0, n - w), n);
            if (slice.length < 2) {
                z_scores[w] = { effort: 0, result: 0, ngr: 0, elas: 0 };
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

            z_scores[w] = { effort: effZ, result: resZ, ngr: ngrZ, elas: elasZ };
        }

        // 5. Classification (Based on Window 20)
        const primaryZ = z_scores["20"] || z_scores["10"] || { effort: 0, result: 0, elas: 0 }; // Fallback
        const effortZ = primaryZ.effort;
        const resultZ = primaryZ.result;
        const elasZ = primaryZ.elas;
        const ngrZ = primaryZ.ngr;

        // Determine if effort is declining (Trend)
        // Need previous Z-score? Or just check if current effort < mean?
        // Check if Z is decreasing compared to yesterday?
        // We can check if effortZ < previous day's effortZ (needs re-calculation of prev day z? expensive)
        // Simplification: Effort Declining if Effort Z < 0 (Below average) or strictly declining?
        // Original logic: "prevEffortZ = (prevEffort - Mean) / Std".
        // Let's implement previous Z calc for 20 day window if possible.

        let effortDeclining = false;
        if (n > 1) {
            const slice20 = fullSeries.slice(Math.max(0, n - 20), n);
            const prevMetric = fullSeries[n - 2];
            // Re-calc mean/std for the slice ending yesterday?
            // Taking a shortcut: Compare current effort to Mean of LAST 20.
            // If effort < PrevEffort? No.
            // Let's stick to strict Z logic:
            // Construct slice for yesterday: slice(n-21, n-1)
            // This is computationally exp.
            // Simple proxy: effortZ < 0 means below average.
            // Or compare raw effort: currentMetrics.effort < prevMetric.metrics.effort
            effortDeclining = currentMetrics.metrics.effort < prevMetric.metrics.effort;
        }

        const slice20 = fullSeries.slice(Math.max(0, n - 20), n);
        const elasVals = slice20.map(s => s.metrics.elas);
        const elasMean20 = elasVals.reduce((a, b) => a + b, 0) / elasVals.length;

        let state = 'NEUTRAL';
        const isEffortHigh = effortZ > 0.5;
        const isEffortLow = effortZ < -0.5;
        const isResultLow = resultZ < 0;

        // READY MARKUP: Effort Declining (selling pressure gone?), Price Stable (Result Low), Elasticty High (Price moves easily with little net)
        if (effortDeclining && resultZ > -0.5 && elasticity > elasMean20 * 1.1) {
            state = 'READY_MARKUP';
        } else if (isEffortHigh && Math.abs(resultZ) < 0.5) {
            state = 'TRANSITION';
        } else if (isEffortHigh && resultZ < -0.5 && ret >= 0) {
            state = 'ACCUMULATION'; // High effort, price stable/up (absorption)
        } else if (isEffortHigh && ret < -0.01) {
            state = 'DISTRIBUTION'; // High effort, price drop
        }

        if (state === 'NEUTRAL' && isEffortLow && isResultLow) state = 'NEUTRAL';

        // 6. Internal Score
        const score = (this.W1 * effortZ) - (this.W2 * Math.abs(resultZ)) + (this.W3 * (1 - elasZ)) + (this.W4 * ngrZ);

        return {
            date: dateStr,
            close,
            metrics: currentMetrics.metrics,
            z_scores: z_scores, // Map { "5": {...}, "20": {...} }
            state,
            internal_score: score
        };
    }
}
