/**
 * @module flow-aggregator
 * @description Extracts foreign/local/retail net flow from scraped broker summary
 * and upserts into D1 `daily_broker_flow` table.
 * 
 * Called after each successful scrape in the queue consumer.
 * The pre-aggregated data enables instant screener filtering without R2 reads.
 *
 * Classification source: D1 `brokers` table `category` field
 *   - 'Foreign fund' → foreign
 *   - 'Retail'       → retail
 *   - Everything else → local (including 'Local fund')
 * 
 * Additionally, brokers with IPOT `type === 'Asing'` are treated as foreign
 * even if not in D1 (covers international brokers not yet seeded).
 */

// In-memory broker category cache (loaded once per worker lifetime)
let _brokerCategoryCache = null;
let _brokerCacheTTL = 0;
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Load broker categories from D1 into memory cache.
 * @param {object} env
 * @returns {Promise<Map<string, string>>} code → category
 */
async function getBrokerCategories(env) {
    const now = Date.now();
    if (_brokerCategoryCache && now < _brokerCacheTTL) {
        return _brokerCategoryCache;
    }

    const map = new Map();
    try {
        const { results } = await env.SSSAHAM_DB.prepare(
            "SELECT code, category FROM brokers"
        ).all();

        if (results) {
            for (const r of results) {
                map.set(r.code, (r.category || 'Local fund').trim());
            }
        }
    } catch (e) {
        console.error('[FLOW-AGG] Error loading broker categories:', e);
    }

    _brokerCategoryCache = map;
    _brokerCacheTTL = now + CACHE_DURATION_MS;
    return map;
}

/**
 * Classify a broker as 'foreign', 'retail', or 'local'.
 * @param {string} code - Broker code (e.g. 'YP')
 * @param {string|undefined} ipotType - The `type` field from IPOT data (e.g. 'Asing')
 * @param {Map<string, string>} categoryMap - From D1 brokers table
 * @returns {'foreign'|'retail'|'local'}
 */
function classifyBroker(code, ipotType, categoryMap) {
    // 1. IPOT type 'Asing' always wins
    if (ipotType === 'Asing') return 'foreign';

    // 2. D1 category lookup
    const cat = categoryMap.get(code);
    if (cat) {
        const lower = cat.toLowerCase();
        if (lower.includes('foreign')) return 'foreign';
        if (lower.includes('retail')) return 'retail';
    }

    // 3. Default: local
    return 'local';
}

/**
 * Extract flow from a scraped R2 broker summary object and upsert into D1.
 *
 * @param {object} env - Worker env bindings
 * @param {string} ticker - e.g. 'BBCA'
 * @param {string} date - e.g. '2026-02-12'
 * @param {object} dailyOutput - The full R2 JSON object from scraper
 *   Shape: { data: { broker_summary: { stock_summary, brokers_buy, brokers_sell } } }
 */
export async function aggregateAndStore(env, ticker, date, dailyOutput) {
    try {
        const bs = dailyOutput?.data?.broker_summary;
        if (!bs) {
            console.warn(`[FLOW-AGG] No broker_summary for ${ticker}/${date}, skipping`);
            return;
        }

        const categoryMap = await getBrokerCategories(env);

        // Accumulators
        let foreignBuy = 0, foreignSell = 0;
        let localBuy = 0, localSell = 0;
        let retailBuy = 0, retailSell = 0;

        // Process buyers
        if (Array.isArray(bs.brokers_buy)) {
            for (const b of bs.brokers_buy) {
                if (!b) continue;
                const val = parseFloat(b.bval) || 0;
                const code = b.netbs_broker_code;
                const ipotType = b.type; // IPOT includes type field

                const cls = classifyBroker(code, ipotType, categoryMap);
                if (cls === 'foreign') foreignBuy += val;
                else if (cls === 'retail') retailBuy += val;
                else localBuy += val;
            }
        }

        // Process sellers
        if (Array.isArray(bs.brokers_sell)) {
            for (const b of bs.brokers_sell) {
                if (!b) continue;
                const val = parseFloat(b.sval) || 0;
                const code = b.netbs_broker_code;
                const ipotType = b.type;

                const cls = classifyBroker(code, ipotType, categoryMap);
                if (cls === 'foreign') foreignSell += val;
                else if (cls === 'retail') retailSell += val;
                else localSell += val;
            }
        }

        const foreignNet = foreignBuy - foreignSell;
        const localNet = localBuy - localSell;
        const retailNet = retailBuy - retailSell;
        const smartNet = foreignNet + localNet;
        const price = parseInt(bs.stock_summary?.average_price || '0');
        const totalValue = bs.stock_summary?.total_value || '0';
        const buyCount = Array.isArray(bs.brokers_buy) ? bs.brokers_buy.length : 0;
        const sellCount = Array.isArray(bs.brokers_sell) ? bs.brokers_sell.length : 0;

        // Upsert into D1
        await env.SSSAHAM_DB.prepare(`
            INSERT INTO daily_broker_flow 
                (date, ticker, foreign_buy, foreign_sell, foreign_net,
                 local_buy, local_sell, local_net,
                 retail_buy, retail_sell, retail_net,
                 smart_net, price, total_value, broker_buy_count, broker_sell_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, ticker) DO UPDATE SET
                foreign_buy = excluded.foreign_buy,
                foreign_sell = excluded.foreign_sell,
                foreign_net = excluded.foreign_net,
                local_buy = excluded.local_buy,
                local_sell = excluded.local_sell,
                local_net = excluded.local_net,
                retail_buy = excluded.retail_buy,
                retail_sell = excluded.retail_sell,
                retail_net = excluded.retail_net,
                smart_net = excluded.smart_net,
                price = excluded.price,
                total_value = excluded.total_value,
                broker_buy_count = excluded.broker_buy_count,
                broker_sell_count = excluded.broker_sell_count,
                created_at = CURRENT_TIMESTAMP
        `).bind(
            date, ticker,
            foreignBuy, foreignSell, foreignNet,
            localBuy, localSell, localNet,
            retailBuy, retailSell, retailNet,
            smartNet, price, totalValue, buyCount, sellCount
        ).run();

    } catch (e) {
        console.error(`[FLOW-AGG] Error for ${ticker}/${date}:`, e);
        // Non-fatal: don't block the scraper pipeline
    }
}

/**
 * Batch backfill: process an existing R2 broksum file into daily_broker_flow.
 * Used for initial backfill when the table is first created.
 *
 * @param {object} env
 * @param {string} ticker
 * @param {string} date
 */
export async function backfillFlowFromR2(env, ticker, date) {
    try {
        const key = `${ticker}/${date}.json`;
        const obj = await env.RAW_BROKSUM.get(key);
        if (!obj) return;

        const data = await obj.json();
        await aggregateAndStore(env, ticker, date, data);
    } catch (e) {
        console.error(`[FLOW-AGG] Backfill error ${ticker}/${date}:`, e);
    }
}
