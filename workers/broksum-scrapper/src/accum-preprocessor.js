/**
 * @module accum-preprocessor
 * @description Cron job that reads daily_broker_flow from D1 and produces
 * pre-computed accumulation artifacts for the screener.
 *
 * Runs at 19:15 WIB (12:15 UTC) Mon-Fri, after daily rewrite + health check.
 *
 * Output: R2 `cache/screener-accum-latest.json` in SSSAHAM_EMITEN bucket.
 *
 * Windows: 2D, 5D, 10D, 20D
 * For each ticker × window:
 *   - fn: foreign net cumulative
 *   - ln: local net cumulative
 *   - rn: retail net cumulative
 *   - sm: smart money net (fn + ln)
 *   - streak: consecutive recent days where smart_net > 0
 *   - allPos: every day in window has smart_net > 0
 *   - pctChg: price change % over the window
 */

const WINDOWS = [2, 5, 10, 20];
const MAX_LOOKBACK_DAYS = 45; // Extra buffer for long holiday periods

/**
 * Main entry point. Called from scheduled() handler.
 *
 * @param {object} env - Worker env bindings
 * @param {Function} sendWebhook - bound this.sendWebhook
 * @returns {Promise<object>} Summary stats
 */
export async function runAccumPreprocessor(env, { sendWebhook }) {
    const startMs = Date.now();
    console.log('[ACCUM] Starting accumulation preprocessor...');

    // 1. Get the last 30 calendar days of trading data from D1
    const endDate = getWIBToday();
    const startDate = subtractDays(endDate, MAX_LOOKBACK_DAYS);

    console.log(`[ACCUM] Fetching daily_broker_flow from ${startDate} to ${endDate}`);

    let rows;
    try {
        const { results } = await env.SSSAHAM_DB.prepare(`
            SELECT
                date,
                ticker,
                SUM(COALESCE(foreign_net, 0)) AS foreign_net,
                SUM(COALESCE(local_net, 0)) AS local_net,
                SUM(COALESCE(retail_net, 0)) AS retail_net,
                SUM(COALESCE(smart_net, 0)) AS smart_net,
                MAX(COALESCE(price, 0)) AS price
            FROM daily_broker_flow
            WHERE date >= ? AND date <= ?
            GROUP BY date, ticker
            ORDER BY ticker, date ASC
        `).bind(startDate, endDate).all();

        rows = results || [];
    } catch (e) {
        console.error('[ACCUM] D1 query failed:', e);
        await sendWebhook(env, `❌ **Accum Preprocessor Failed**\nD1 Error: ${e.message}`);
        return { error: e.message };
    }

    if (rows.length === 0) {
        console.log('[ACCUM] No data found in daily_broker_flow');
        return { items: 0, skipped: true };
    }

    console.log(`[ACCUM] Loaded ${rows.length} rows`);

    // 2. Group rows by ticker
    const tickerMap = new Map();
    for (const row of rows) {
        if (!tickerMap.has(row.ticker)) {
            tickerMap.set(row.ticker, []);
        }
        tickerMap.get(row.ticker).push(row);
    }

    // 3. Compute accumulation for each ticker × window
    const items = [];
    let incompleteWindows = 0;

    for (const [ticker, days] of tickerMap) {
        // Days are already sorted ASC by query
        const accum = {};
        const coverage = {};
        const availableDays = days.length;

        for (const w of WINDOWS) {
            const complete = availableDays >= w;
            coverage[w] = { required: w, available: availableDays, complete };

            // Strict integrity: only compute window metrics if data is complete.
            // This prevents 5D/10D/20D from reusing 2D values on sparse tickers.
            if (!complete) {
                accum[w] = null;
                incompleteWindows++;
                continue;
            }
            const windowDays = days.slice(-w);

            // Cumulative sums
            let fn = 0, ln = 0, rn = 0;
            let allPos = true;
            let foreignAllPos = true;
            let streak = 0;
            let streakCounting = true;

            // Walk from most recent to oldest for streak
            for (let i = windowDays.length - 1; i >= 0; i--) {
                const d = windowDays[i];
                if (streakCounting && d.smart_net > 0) {
                    streak++;
                } else {
                    streakCounting = false;
                }
            }

            // Walk forward for cumulative and allPos
            for (const d of windowDays) {
                fn += d.foreign_net || 0;
                ln += d.local_net || 0;
                rn += d.retail_net || 0;
                if (d.smart_net <= 0) allPos = false;
                if ((d.foreign_net || 0) <= 0) foreignAllPos = false;
            }

            const sm = fn + ln;
            const foreignDominant = fn > 0; // Foreign net kumulatif positif

            // Price change over window
            const firstPrice = windowDays[0]?.price || 0;
            const lastPrice = windowDays[windowDays.length - 1]?.price || 0;
            const pctChg = firstPrice > 0
                ? parseFloat((((lastPrice - firstPrice) / firstPrice) * 100).toFixed(2))
                : 0;

            accum[w] = {
                fn: Math.round(fn),
                ln: Math.round(ln),
                rn: Math.round(rn),
                sm: Math.round(sm),
                streak,
                allPos,
                foreignAllPos,
                foreignDominant,
                days: windowDays.length,
                complete: true,
                pctChg,
            };
        }

        items.push({ t: ticker, accum, coverage });
    }

    // 4. Write to R2 cache
    const output = {
        generated_at: new Date().toISOString(),
        date: endDate,
        windows: WINDOWS,
        count: items.length,
        items,
    };

    try {
        await env.SSSAHAM_EMITEN.put(
            'cache/screener-accum-latest.json',
            JSON.stringify(output),
            { httpMetadata: { contentType: 'application/json' } }
        );
        console.log(`[ACCUM] Written ${items.length} tickers to R2 cache`);
    } catch (e) {
        console.error('[ACCUM] R2 write failed:', e);
    }

    const elapsed = Date.now() - startMs;
    const summary = `✅ **Accum Preprocessor Complete**\nTickers: ${items.length}\nWindows: ${WINDOWS.join(', ')}\nD1 rows: ${rows.length}\nIncomplete windows: ${incompleteWindows}\nTime: ${elapsed}ms`;
    console.log(`[ACCUM] ${summary}`);
    if (typeof sendWebhook === 'function') {
        await sendWebhook(env, summary);
    }

    return { items: items.length, elapsed, incompleteWindows };
}

// ========================================
// HELPERS
// ========================================

function getWIBToday() {
    const now = new Date();
    const wibOffset = 7 * 60 * 60 * 1000;
    const wib = new Date(now.getTime() + wibOffset);
    return wib.toISOString().split('T')[0];
}

function subtractDays(dateStr, n) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().split('T')[0];
}
