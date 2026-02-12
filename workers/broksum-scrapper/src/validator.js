/**
 * @module validator
 * @description Smart validation for broker summary data.
 * Used by:
 *   - scraper (Layer 1: real-time validation before R2 save)
 *   - health-check (Layer 2: daily H-1 sample validation)
 *
 * @see workers/_DOC/0003_brokersummary.md — Section 14
 */

const RULES = {
    MAX_PRICE_CHANGE_PCT: 35,  // ARA/ARB IDX = 25-35%
    MIN_BROKERS_COUNT: 1,       // Minimal 1 broker per side
};

/**
 * Validate a raw R2 broker summary object.
 *
 * @param {object} raw - The full R2 JSON object (as saved by scraper)
 *   Expected shape: { data: { broker_summary: { stock_summary, brokers_buy, brokers_sell }, bandar_detector } }
 * @param {object|null} prevRaw - Previous trading day R2 object (for price comparison)
 * @returns {{ valid: boolean, issues: string[], severity: 'OK'|'WARNING'|'CRITICAL' }}
 */
export function validateBroksum(raw, prevRaw = null) {
    const issues = [];

    // --- Guard: data exists ---
    if (!raw || !raw.data) {
        return { valid: false, issues: ['Data object is null/undefined'], severity: 'CRITICAL' };
    }

    const bs = raw.data.broker_summary;
    const bd = raw.data.bandar_detector;

    if (!bs) {
        return { valid: false, issues: ['broker_summary missing'], severity: 'CRITICAL' };
    }

    // --- 1. Price check ---
    const price = parseInt(bs.stock_summary?.average_price || '0');
    if (price <= 0) {
        issues.push('price=0 (stock_summary.average_price missing or zero)');
    }

    // --- 2. Broker list check ---
    const buyCount = Array.isArray(bs.brokers_buy) ? bs.brokers_buy.length : 0;
    const sellCount = Array.isArray(bs.brokers_sell) ? bs.brokers_sell.length : 0;

    if (buyCount < RULES.MIN_BROKERS_COUNT) {
        issues.push(`brokers_buy empty (count: ${buyCount})`);
    }
    if (sellCount < RULES.MIN_BROKERS_COUNT) {
        issues.push(`brokers_sell empty (count: ${sellCount})`);
    }

    // --- 3. Summary vs broker consistency ---
    const totalValue = bs.stock_summary?.total_value || '0';
    const hasTradingValue = BigInt(totalValue.replace(/,/g, '') || '0') > 0n;

    if (hasTradingValue && buyCount === 0 && sellCount === 0) {
        issues.push(`total_value=${totalValue} but 0 brokers (summary exists, broker list empty)`);
    }

    // --- 4. Frequency vs value consistency ---
    const frequency = parseInt(bd?.frequency || bs.stock_summary?.total_freq || '0');
    if (frequency > 0 && !hasTradingValue) {
        issues.push(`frequency=${frequency} but total_value=0 (incomplete data)`);
    }

    // --- 5. Price anomaly vs previous day ---
    if (prevRaw && price > 0) {
        const prevBs = prevRaw.data?.broker_summary;
        const prevPrice = parseInt(prevBs?.stock_summary?.average_price || '0');

        if (prevPrice > 0) {
            const changePct = Math.abs((price - prevPrice) / prevPrice * 100);
            if (changePct > RULES.MAX_PRICE_CHANGE_PCT) {
                issues.push(`price change ${changePct.toFixed(1)}% exceeds ${RULES.MAX_PRICE_CHANGE_PCT}% (${prevPrice} → ${price})`);
            }
        }
    }

    // --- Determine severity ---
    const severity = determineSeverity(issues);

    return {
        valid: issues.length === 0,
        issues,
        severity,
    };
}

/**
 * Determine overall severity from issue list.
 * Any structural data issue = CRITICAL (needs repair).
 * Price anomaly only = WARNING (data exists but suspicious).
 */
function determineSeverity(issues) {
    if (issues.length === 0) return 'OK';

    const critical = issues.some(i =>
        i.includes('price=0') ||
        i.includes('brokers_buy empty') ||
        i.includes('brokers_sell empty') ||
        i.includes('broker list empty') ||
        i.includes('incomplete data') ||
        i.includes('null/undefined') ||
        i.includes('missing')
    );

    return critical ? 'CRITICAL' : 'WARNING';
}

/**
 * Quick check: does a raw R2 object have valid broker data?
 * Lighter version for use in smart-save "should I overwrite?" checks.
 *
 * @param {object} raw - R2 JSON object
 * @returns {boolean}
 */
export function hasValidBrokerData(raw) {
    if (!raw?.data?.broker_summary) return false;
    const bs = raw.data.broker_summary;
    const buyCount = Array.isArray(bs.brokers_buy) ? bs.brokers_buy.length : 0;
    const sellCount = Array.isArray(bs.brokers_sell) ? bs.brokers_sell.length : 0;
    return buyCount > 0 || sellCount > 0;
}
