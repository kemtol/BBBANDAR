/**
 * @module health-check
 * @description Daily Health Check — Layer 2 protection for broker summary data.
 * Runs via cron at 19:00 WIB (12:00 UTC), Mon-Fri.
 * Samples H-1 data for ~60 emiten, validates, and triggers repair if needed.
 *
 * @see workers/_DOC/0003_brokersummary.md — Section 14
 */

import { validateBroksum } from './validator.js';

// LQ45 / IDX30 — always checked
const MANDATORY_CHECK = [
    'BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII', 'UNVR',
    'HMSP', 'ICBP', 'INDF', 'KLBF', 'PGAS', 'SMGR', 'TOWR',
    'EXCL', 'ANTM', 'INCO', 'PTBA', 'ADRO', 'MDKA', 'ACES',
    'BRIS', 'ARTO', 'GOTO', 'BREN', 'AMMN', 'CPIN', 'MAPI',
    'ESSA', 'BRPT',
];

const RANDOM_SAMPLE_SIZE = 30;
const CRITICAL_THRESHOLD = 0.10; // 10%

/**
 * Main health-check entry point. Called from scheduled() handler.
 *
 * @param {object} env - Worker environment bindings
 * @param {object} ctx - Execution context (for ctx.waitUntil)
 * @param {Function} sendWebhook - Webhook sender function (this.sendWebhook bound)
 * @param {Function} getWatchlist - Watchlist getter (this.getWatchlistFromKV bound)
 * @returns {Promise<object>} Health report
 */
export async function runHealthCheck(env, ctx, { sendWebhook, getWatchlist }) {
    const targetDate = getPreviousTradingDay();
    const prevDate = getPreviousTradingDay(targetDate);

    console.log(`[HEALTH] Starting health check for H-1: ${targetDate} (prev: ${prevDate})`);

    const report = {
        date: targetDate,
        checkedAt: new Date().toISOString(),
        totalChecked: 0,
        healthy: 0,
        warning: 0,
        critical: 0,
        criticalEmitens: [],
        warningEmitens: [],
        repairTriggered: false,
        repairType: null,
    };

    // 1. Build sample list
    const sampleList = await buildSampleList(env, getWatchlist);
    report.totalChecked = sampleList.length;
    console.log(`[HEALTH] Checking ${sampleList.length} emitens`);

    // 2. Validate each emiten
    for (const code of sampleList) {
        try {
            const key = `${code}/${targetDate}.json`;
            const obj = await env.RAW_BROKSUM.get(key);

            if (!obj) {
                report.critical++;
                report.criticalEmitens.push({ code, issues: ['R2 file not found'] });
                continue;
            }

            const raw = await obj.json();

            // Get previous day for comparison
            let prevRaw = null;
            try {
                const prevKey = `${code}/${prevDate}.json`;
                const prevObj = await env.RAW_BROKSUM.get(prevKey);
                if (prevObj) prevRaw = await prevObj.json();
            } catch (_) { /* ignore */ }

            const result = validateBroksum(raw, prevRaw);

            if (result.severity === 'CRITICAL') {
                report.critical++;
                report.criticalEmitens.push({ code, issues: result.issues });
            } else if (result.severity === 'WARNING') {
                report.warning++;
                report.warningEmitens.push({ code, issues: result.issues });
            } else {
                report.healthy++;
            }
        } catch (err) {
            report.critical++;
            report.criticalEmitens.push({ code, issues: [`Error: ${err.message}`] });
        }
    }

    // 3. Decision: repair or not?
    const criticalRate = report.totalChecked > 0
        ? report.critical / report.totalChecked
        : 0;

    console.log(`[HEALTH] Results: ${report.healthy} healthy, ${report.warning} warning, ${report.critical} critical (${(criticalRate * 100).toFixed(1)}%)`);

    if (criticalRate > CRITICAL_THRESHOLD) {
        // >10% — scraper was globally broken. Full rebuild.
        report.repairTriggered = true;
        report.repairType = 'FULL_REBUILD';

        console.log(`[HEALTH] ⚠️ Critical rate ${(criticalRate * 100).toFixed(1)}% — FULL REBUILD for ${targetDate}`);

        await triggerFullRebuild(env, targetDate);

        const msg = `⚠️ **Health Check: FULL REBUILD**\n` +
            `Date: ${targetDate}\n` +
            `Critical: ${report.critical}/${report.totalChecked} (${(criticalRate * 100).toFixed(0)}%)\n` +
            `Samples: ${report.criticalEmitens.slice(0, 10).map(e => e.code).join(', ')}${report.criticalEmitens.length > 10 ? '...' : ''}`;
        await sendWebhook(env, msg);

    } else if (report.critical > 0) {
        // Some emitens broken. Selective repair.
        report.repairTriggered = true;
        report.repairType = 'SELECTIVE_REPAIR';

        const codes = report.criticalEmitens.map(e => e.code);
        console.log(`[HEALTH] 🔧 Selective repair: ${codes.join(', ')}`);

        await triggerSelectiveRepair(env, targetDate, codes);

        const msg = `🔧 **Health Check: SELECTIVE REPAIR**\n` +
            `Date: ${targetDate}\n` +
            `Repairing ${codes.length} emiten: ${codes.join(', ')}`;
        await sendWebhook(env, msg);

    } else {
        const msg = `✅ **Health Check: All Healthy**\n` +
            `Date: ${targetDate}\n` +
            `Checked: ${report.totalChecked} | Healthy: ${report.healthy} | Warning: ${report.warning}`;
        console.log(`[HEALTH] ${msg}`);
        await sendWebhook(env, msg);
    }

    // 4. Save report to KV
    try {
        await env.SSSAHAM_WATCHLIST.put(
            `health-report:${targetDate}`,
            JSON.stringify(report),
            { expirationTtl: 30 * 24 * 60 * 60 } // 30 days
        );
    } catch (e) {
        console.error('[HEALTH] Failed to save report to KV:', e);
    }

    return report;
}

// ========================================
// HELPERS
// ========================================

/**
 * Build a sample list: all mandatory + random selection from watchlist.
 */
async function buildSampleList(env, getWatchlist) {
    const list = new Set(MANDATORY_CHECK);

    try {
        const watchlist = await getWatchlist(env);
        if (Array.isArray(watchlist) && watchlist.length > 0) {
            // Shuffle and pick RANDOM_SAMPLE_SIZE that aren't already in mandatory
            const candidates = watchlist.filter(code => !list.has(code));
            shuffleArray(candidates);
            candidates.slice(0, RANDOM_SAMPLE_SIZE).forEach(code => list.add(code));
        }
    } catch (e) {
        console.error('[HEALTH] Error building sample list:', e);
    }

    return [...list];
}

/**
 * Fisher-Yates shuffle (in place).
 */
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

/**
 * Trigger full rebuild: queue ALL emiten for a specific date via the scrape queue.
 */
async function triggerFullRebuild(env, dateStr) {
    try {
        // Write a rebuild request to KV — the next cron sweep or manual trigger can pick it up
        await env.SSSAHAM_WATCHLIST.put(`repair:${dateStr}`, JSON.stringify({
            type: 'FULL',
            date: dateStr,
            requestedAt: new Date().toISOString(),
            status: 'PENDING',
        }), { expirationTtl: 3 * 24 * 60 * 60 }); // 3 days

        // Also enqueue directly if possible
        let watchlistRaw = await env.SSSAHAM_WATCHLIST.get('EMITEN_LIST');
        let watchlist = [];
        if (watchlistRaw) {
            try { watchlist = JSON.parse(watchlistRaw); } catch (_) { }
        }

        if (watchlist.length > 0 && env.SSSAHAM_QUEUE) {
            const messages = watchlist.map(symbol => ({
                body: { symbol, date: dateStr, overwrite: true, attempt: 0, source: 'health-repair' }
            }));

            // Batch in chunks of 50
            for (let i = 0; i < messages.length; i += 50) {
                await env.SSSAHAM_QUEUE.sendBatch(messages.slice(i, i + 50));
            }
            console.log(`[REPAIR] Full rebuild: queued ${watchlist.length} emitens for ${dateStr}`);
        }
    } catch (e) {
        console.error(`[REPAIR] Error triggering full rebuild:`, e);
    }
}

/**
 * Trigger selective repair: queue only specific emiten for a date.
 */
async function triggerSelectiveRepair(env, dateStr, codes) {
    try {
        // Save to KV
        await env.SSSAHAM_WATCHLIST.put(`repair:${dateStr}:selective`, JSON.stringify({
            type: 'SELECTIVE',
            date: dateStr,
            codes,
            requestedAt: new Date().toISOString(),
            status: 'PENDING',
        }), { expirationTtl: 3 * 24 * 60 * 60 });

        // Enqueue directly
        if (env.SSSAHAM_QUEUE) {
            const messages = codes.map(symbol => ({
                body: { symbol, date: dateStr, overwrite: true, attempt: 0, source: 'health-repair' }
            }));

            for (let i = 0; i < messages.length; i += 50) {
                await env.SSSAHAM_QUEUE.sendBatch(messages.slice(i, i + 50));
            }
            console.log(`[REPAIR] Selective repair: queued ${codes.length} emitens for ${dateStr}`);
        }
    } catch (e) {
        console.error(`[REPAIR] Error triggering selective repair:`, e);
    }
}

/**
 * Get the previous trading day (skip weekends) from a date string or today.
 * @param {string} [fromDateStr] - ISO date string (YYYY-MM-DD). Defaults to today WIB.
 * @returns {string} ISO date string of previous trading day
 */
function getPreviousTradingDay(fromDateStr) {
    let d;
    if (fromDateStr) {
        d = new Date(fromDateStr + 'T12:00:00Z'); // Noon UTC to avoid timezone edge
    } else {
        // Default: today in WIB
        const now = new Date();
        const wibOffset = 7 * 60 * 60 * 1000;
        d = new Date(now.getTime() + wibOffset);
    }

    // Go back 1 day, skip weekends
    do {
        d.setUTCDate(d.getUTCDate() - 1);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);

    return d.toISOString().split('T')[0];
}
