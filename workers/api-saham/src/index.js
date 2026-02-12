import openapi from "./openapi.json";

const PUBLIC_PATHS = new Set(["/", "/docs", "/console", "/openapi.json", "/health", "/screener", "/screener-accum", "/cache-summary", "/features/history"]);

// ==============================
// CORS helper
// ==============================
function withCORS(resp) {
  const headers = new Headers(resp.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");

  return new Response(resp.body, {
    status: resp.status || 200,
    headers
  });
}

function json(data, status = 200, extraHeaders = {}) {
  return withCORS(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders
      }
    })
  );
}

// ==============================
// LOGIC: Aggregation (Ported)
// ==============================

// ==============================
// LOGIC: Footprint Range Aggregator (v3)
// ==============================
async function calculateFootprintRange(env, fromDateStr, toDateStr) {
  // 1. Time Locking Strategy
  // Start: 09:00 WIB (02:00 UTC) on fromDate
  const startTs = new Date(`${fromDateStr}T02:00:00Z`).getTime();

  // End: 
  // If toDate is Today (UTC date matches), use NOW.
  // If toDate is Past, use 16:00 WIB (09:00 UTC).
  const now = new Date();
  const toDate = new Date(toDateStr);
  const todayStr = now.toISOString().split("T")[0];

  let endTs;
  if (toDateStr === todayStr) {
    endTs = now.getTime();
  } else {
    endTs = new Date(`${toDateStr}T09:00:00Z`).getTime();
  }

  console.log(`[RANGE] Aggregating ${fromDateStr} to ${toDateStr} (${startTs} - ${endTs})`);

  // 2. Fetch Footprint Aggregates (L1)
  const { results } = await env.SSSAHAM_DB.prepare(`
        SELECT 
            ticker,
            SUM(vol) as total_vol,
            SUM(delta) as total_delta,
            MIN(time_key) as first_time,
            MAX(time_key) as last_time,
            MAX(close) as high,
            MIN(close) as low
        FROM temp_footprint_consolidate
        WHERE time_key >= ? AND time_key <= ?
        GROUP BY ticker
    `).bind(startTs, endTs).all();

  if (!results || results.length === 0) return { items: [] };

  // 3. Enrich with OHLC (Open from first_time, Close from last_time)
  // We fetch open/close in batches to avoid N+1
  const enriched = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const chunk = results.slice(i, i + BATCH_SIZE);
    const conditions = chunk.map(r => `(ticker = '${r.ticker}' AND time_key IN (${r.first_time}, ${r.last_time}))`).join(" OR ");

    if (conditions) {
      const { results: ohlc } = await env.SSSAHAM_DB.prepare(`
                SELECT ticker, time_key, open, close
                FROM temp_footprint_consolidate
                WHERE ${conditions}
            `).all();

      const mapped = chunk.map(row => {
        const matches = ohlc.filter(r => r.ticker === row.ticker);
        const openRow = matches.find(r => r.time_key === row.first_time);
        const closeRow = matches.find(r => r.time_key === row.last_time);
        const open = openRow ? openRow.open : (closeRow ? closeRow.open : 0);
        const close = closeRow ? closeRow.close : (openRow ? openRow.close : 0);
        return { ...row, open, close };
      });
      enriched.push(...mapped);
    } else {
      enriched.push(...chunk);
    }
  }

  // 4. Fetch Context (L2) - From StartDate - 1 Day
  // We assume 'daily_features' has entry for prev day.
  const ctxRow = await env.SSSAHAM_DB.prepare(`
        SELECT MAX(date) as ctx_date FROM daily_features WHERE date < ?
    `).bind(fromDateStr).first();

  const contextMap = new Map();
  if (ctxRow && ctxRow.ctx_date) {
    const { results: ctxList } = await env.SSSAHAM_DB.prepare(`
            SELECT ticker, state as hist_state, z_ngr as hist_z_ngr
            FROM daily_features
            WHERE date = ?
        `).bind(ctxRow.ctx_date).all();
    if (ctxList) ctxList.forEach(c => contextMap.set(c.ticker, c));
  }

  // 5. Calculate Hybrid Scores
  const items = enriched.map(fp => {
    const ctx = contextMap.get(fp.ticker) || {};
    return calculateHybridItem(fp, ctx);
  }).filter(i => i !== null);

  // 6. Return Format
  return {
    generated_at: new Date().toISOString(),
    range: { from: fromDateStr, to: toDateStr },
    count: items.length,
    items: items
  };
}

// Helpers (Ported from features-service)
function normalize(value, min, max) {
  if (max === min) return 0.5;
  const n = (value - min) / (max - min);
  return Math.max(0, Math.min(1, n));
}

/**
 * Checks if the fetched footprint data is complete based on market hours.
 * Market: 09:00 - 16:00 WIB (02:00 - 09:00 UTC)
 */
function checkDataCompleteness(candles, dateStr) {
  if (!candles || candles.length === 0) return { isIncomplete: true, reason: "NO_DATA" };

  const now = new Date();
  // Get current time in WIB
  const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const todayWIBStr = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth() + 1).padStart(2, '0')}-${String(nowWIB.getDate()).padStart(2, '0')}`;
  const nowUTC = now.toISOString().slice(11, 16);
  const nowWIBTime = `${String(nowWIB.getHours()).padStart(2, '0')}:${String(nowWIB.getMinutes()).padStart(2, '0')}`;

  const lastCandle = candles[candles.length - 1];
  const lastCandleDate = new Date(lastCandle.t0);
  const lastCandleWIB = new Date(lastCandleDate.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const lastCandleUTC = lastCandleDate.toISOString().slice(11, 16);
  const lastWIBTime = `${String(lastCandleWIB.getHours()).padStart(2, '0')}:${String(lastCandleWIB.getMinutes()).padStart(2, '0')}`;

  const lastH = lastCandleWIB.getHours();
  const lastM = lastCandleWIB.getMinutes();
  const isToday = dateStr === todayWIBStr;
  const nowH = nowWIB.getHours();
  const nowM = nowWIB.getMinutes();
  const dayOfWeek = nowWIB.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // Market hours constants
  const marketOpenHour = 9;
  const marketCloseHour = 16;

  console.log(`[COMPLETION] ========================================`);
  console.log(`[COMPLETION] dateStr=${dateStr}, isToday=${isToday}`);
  console.log(`[COMPLETION] NOW: ${nowWIBTime} WIB (${nowUTC} UTC), Weekend=${isWeekend}`);
  console.log(`[COMPLETION] Last candle: ${lastWIBTime} WIB (${lastCandleUTC} UTC)`);
  console.log(`[COMPLETION] Candle count: ${candles.length}`);

  // Calculate expected candles based on elapsed market time
  let expectedCandles = 0;
  if (isToday && !isWeekend && nowH >= marketOpenHour) {
    // Today: calculate from 09:00 to current time (or market close if past 16:00)
    const effectiveEndH = Math.min(nowH, marketCloseHour);
    const effectiveEndM = nowH < marketCloseHour ? nowM : 0;
    const elapsedMins = (effectiveEndH - marketOpenHour) * 60 + effectiveEndM;
    expectedCandles = Math.floor(elapsedMins / 5); // 5-min candles
    console.log(`[COMPLETION] Today: 09:00-${nowWIBTime} WIB = ${elapsedMins} mins = ~${expectedCandles} expected candles`);
  } else if (!isToday) {
    // Past trading day: full session 09:00-16:00 = 7 hours = 420 mins = 84 candles
    expectedCandles = 84;
    console.log(`[COMPLETION] Past day: Full session 09:00-16:00 = ~84 expected candles`);
  }

  // Sparse check with 50% tolerance (allow sparse stocks like CASA)
  const sparseThreshold = Math.max(Math.floor(expectedCandles * 0.5), 5);
  console.log(`[COMPLETION] Sparse threshold: ${sparseThreshold} (50% of ${expectedCandles})`);

  // 1. Sparse Data Check - relative to expected candles
  if (expectedCandles > 0 && candles.length < sparseThreshold) {
    console.log(`[COMPLETION] RESULT: SPARSE_DATA (${candles.length} < ${sparseThreshold})`);
    return { isIncomplete: true, reason: "SPARSE_DATA", count: candles.length, expected: expectedCandles, threshold: sparseThreshold };
  }

  // 2. Past Day Completeness: Should reach at least 15:50 WIB
  if (!isToday) {
    if (lastH < 15 || (lastH === 15 && lastM < 50)) {
      console.log(`[COMPLETION] RESULT: PAST_DAY_INCOMPLETE (last candle at ${lastWIBTime}, expected >= 15:50)`);
      return { isIncomplete: true, reason: "PAST_DAY_INCOMPLETE", last: lastWIBTime };
    }
  } else if (!isWeekend) {
    // 3. Today Stale Check: During market hours, data should be within 20 mins
    if (nowH >= marketOpenHour && nowH < marketCloseHour) {
      const diffMs = nowWIB.getTime() - lastCandleWIB.getTime();
      if (diffMs > 20 * 60000) {
        console.log(`[COMPLETION] RESULT: TODAY_STALE (last candle ${Math.floor(diffMs / 60000)} mins ago)`);
        return { isIncomplete: true, reason: "TODAY_STALE", diffMins: Math.floor(diffMs / 60000) };
      }
    }
  }

  console.log(`[COMPLETION] RESULT: COMPLETE ✓`);
  return { isIncomplete: false, expectedCandles, actualCandles: candles.length };
}

function getSignal(score, deltaPct, histZNGR, histState, pricePct) {
  // Hybrid Signal Alignment
  const isAccum = histState === 'ACCUMULATION';
  const isDistrib = histState === 'DISTRIBUTION';
  const isBuying = deltaPct > 0;
  const isSelling = deltaPct < 0;
  const isPriceUp = pricePct > 0;

  // 1. STRONG BUY: Historical Accumulation + Today Buying + High Score
  if (isAccum && isBuying && score > 0.75) return 'STRONG_BUY';

  // 2. MARKUP: Strong Buying + Price Up (Momentum)
  if (isBuying && isPriceUp && score > 0.8) return 'MARKUP';

  // 3. TRAP WARNING: Distribution Context + Today Buying (Fakeout)
  if (isDistrib && isBuying) return 'TRAP_WARNING';

  // 4. HIDDEN ACCUM: Low Price/Drop + Buying Pressure (Absorption)
  if (!isPriceUp && isBuying && isAccum) return 'HIDDEN_ACCUM';

  // 5. STRONG SELL: Distribution + Selling
  if (isDistrib && isSelling && score < 0.25) return 'STRONG_SELL';

  if (score > 0.6) return 'BUY';
  if (score < 0.4) return 'SELL';

  return 'NEUTRAL';
}

function calculateHybridItem(footprint, context) {
  const open = footprint.open || 0;
  const close = footprint.close || 0;
  const vol = footprint.total_vol || 0;
  const delta = footprint.total_delta || 0;
  const high = footprint.high || close;
  const low = footprint.low || close;

  if (vol === 0 || open === 0) return null;

  const deltaPct = (delta / vol) * 100;
  const pricePct = ((close - open) / open) * 100;

  // NEW: Calculate missing fields
  const range = high - low;
  const fluktuasi = close > 0 ? ((high - low) / close) * 100 : 0;
  const absCvd = Math.abs(deltaPct) / (1 + Math.abs(pricePct)); // Normalized Absorption Score

  // Real-Time Component (70%)
  // Normalize Delta: Expecting -25% to +25% as significant range (Net Delta)
  const normDelta = normalize(deltaPct, -25, 25);
  // Normalize Price: Expecting -5% to +5% as significant day range
  const normPrice = normalize(pricePct, -5, 5);
  const rtScore = (0.7 * normDelta) + (0.3 * normPrice);

  // Historical Component (30%)
  const hist_z_ngr = context.hist_z_ngr || 0;
  const hist_state = context.hist_state || 'NEUTRAL';

  // Normalize Z-Score: -3 to +3
  let normZNGR = normalize(hist_z_ngr, -3, 3);

  // State Boost/Penalty
  if (hist_state === 'ACCUMULATION') normZNGR += 0.1; // Boost
  if (hist_state === 'DISTRIBUTION') normZNGR -= 0.1; // Penalty

  // Clamp Score
  const histScore = Math.max(0, Math.min(1, normZNGR));

  // Final Hybrid Formula
  const hybridScore = (0.7 * rtScore) + (0.3 * histScore);

  const signal = getSignal(hybridScore, deltaPct, hist_z_ngr, hist_state, pricePct);

  return {
    t: footprint.ticker,
    d: parseFloat(deltaPct.toFixed(2)),
    p: parseFloat(pricePct.toFixed(2)),
    v: vol,
    h: high,
    l: low,
    r: range,
    f: parseFloat(fluktuasi.toFixed(2)),
    div: parseFloat(absCvd.toFixed(2)),
    ctx_net: parseFloat(hist_z_ngr.toFixed(2)),
    ctx_st: hist_state,
    sc: parseFloat(hybridScore.toFixed(3)),
    sig: signal
  };
}

async function calculateRangeData(env, symbol, startDate, endDate) {
  const results = [];
  const accBrokers = {};
  const errors = [];

  // 0. Fetch Brokers Mapping
  let brokersMap = {};
  try {
    const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
    if (results) {
      results.forEach(b => brokersMap[b.code] = b);
    }
  } catch (e) {
    console.error("Error fetching brokers mapping:", e);
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Loop through dates
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const key = `${symbol}/${dateStr}.json`; // Key format from scrapper

    try {
      const object = await env.RAW_BROKSUM.get(key);
      if (object) {
        const fullOuter = await object.json();
        if (fullOuter && fullOuter.data) {
          const bd = fullOuter.data.bandar_detector;
          const bs = fullOuter.data.broker_summary;

          // 1. Calculate Daily Flow
          let foreignBuy = 0, foreignSell = 0;
          let retailBuy = 0, retailSell = 0;
          let localBuy = 0, localSell = 0;

          const isRetail = (code) => {
            const b = brokersMap[code];
            if (!b) return false;
            const cat = (b.category || '').toLowerCase();
            return cat.includes('retail');
          };

          // 2. Aggregate Broker Summary
          if (bs) {
            const process = (list, type) => {
              if (list && Array.isArray(list)) {
                list.forEach(b => {
                  if (!b) return;
                  const val = parseFloat(type === 'buy' ? b.bval : b.sval) || 0;
                  const vol = parseFloat(type === 'buy' ? b.blotv || b.blot * 100 : b.slotv || b.slot * 100) || 0;
                  const code = b.netbs_broker_code;

                  if (type === 'buy') {
                    if (isRetail(code)) retailBuy += val;
                    else if (b.type === "Asing") foreignBuy += val;
                    else localBuy += val;

                    if (code) {
                      if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                      accBrokers[code].bval += val;
                      accBrokers[code].bvol += vol;
                    }
                  } else {
                    if (isRetail(code)) retailSell += val;
                    else if (b.type === "Asing") foreignSell += val;
                    else localSell += val;

                    if (code) {
                      if (!accBrokers[code]) accBrokers[code] = { bval: 0, sval: 0, bvol: 0, svol: 0, type: b.type };
                      accBrokers[code].sval += val;
                      accBrokers[code].svol += vol;
                    }
                  }
                });
              }
            };
            process(bs.brokers_buy, 'buy');
            process(bs.brokers_sell, 'sell');
          }

          const summary = {
            detector: bd,
            price: bs?.stock_summary?.average_price ? parseInt(bs.stock_summary.average_price) : 0,
            foreign: { buy_val: foreignBuy, sell_val: foreignSell, net_val: foreignBuy - foreignSell },
            retail: { buy_val: retailBuy, sell_val: retailSell, net_val: retailBuy - retailSell },
            local: { buy_val: localBuy, sell_val: localSell, net_val: localBuy - localSell }
          };
          results.push({ date: dateStr, data: summary });
        }
      }
    } catch (e) {
      // ignore missing
    }
  }

  // 6. On-Demand Backfill Trigger (If results empty)
  // Logic: If user requests data < 30 days ago, and we have 0 results, trigger backfill.
  // 6. On-Demand Backfill Trigger (If data incomplete or empty)
  // Calculate expected trading days (rough estimate: 70% of calendar days)
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const expectedTradingDays = Math.floor(diffDays * 0.7); // ~5 days per week
  const actualDays = results.length;
  const completeness = expectedTradingDays > 0 ? actualDays / expectedTradingDays : 0;

  console.log(`[DATA CHECK] ${symbol}: Expected ${expectedTradingDays}, Got ${actualDays}, Completeness: ${(completeness * 100).toFixed(1)}%`);

  // Trigger backfill if EMPTY or INCOMPLETE
  if (results.length === 0 || completeness < 0.7) { // Less than 70% complete
    if (env.BROKSUM_SERVICE) {
      const reason = results.length === 0 ? 'empty' : `incomplete (${(completeness * 100).toFixed(1)}%)`;
      console.log(`[BACKFILL] Triggering for ${symbol}: ${reason}`);

      // Fire & Forget
      env.BROKSUM_SERVICE.fetch(`http://internal/auto-backfill?symbol=${symbol}&days=90&force=false`)
        .catch(e => console.error("Backfill Trigger Failed:", e));

      if (results.length === 0) {
        return {
          generated_at: new Date().toISOString(),
          backfill_active: true, // Signal to Frontend
          completeness: completeness,
          expected_days: expectedTradingDays,
          actual_days: actualDays,
          history: [],
          summary: {
            foreign: { buy_val: 0, sell_val: 0, net_val: 0 },
            retail: { buy_val: 0, sell_val: 0, net_val: 0 },
            local: { buy_val: 0, sell_val: 0, net_val: 0 }
          }
        };
      }

      // Partial Data: Return what we have + flag
      // We continue to return `results` but we need to inject the flag into the final response logic.
      // The return structure of `calculateRangeData` is { history, summary }.
      // We can attach extra metadata property? No, caller expects {history, summary}.
      // But the caller (GET /cache-summary) wraps this in JSON.
      // We should attach the flag to the return object.
    }
  }

  // Format Top Brokers
  const format = (type) => Object.keys(accBrokers)
    .map(k => ({ code: k, ...accBrokers[k] }))
    .sort((a, b) => b[type] - a[type])
    .slice(0, 20);

  const allNet = Object.keys(accBrokers).map(k => ({
    code: k, ...accBrokers[k], net: accBrokers[k].bval - accBrokers[k].sval
  }));

  // Calculate Aggregated Stats for the Range
  let aggForeign = { buy: 0, sell: 0, net: 0 };
  let aggRetail = { buy: 0, sell: 0, net: 0 };
  let aggLocal = { buy: 0, sell: 0, net: 0 };

  results.forEach(r => {
    if (r.data) {
      aggForeign.buy += r.data.foreign?.buy_val || 0;
      aggForeign.sell += r.data.foreign?.sell_val || 0;

      aggRetail.buy += r.data.retail?.buy_val || 0;
      aggRetail.sell += r.data.retail?.sell_val || 0;

      aggLocal.buy += r.data.local?.buy_val || 0;
      aggLocal.sell += r.data.local?.sell_val || 0;
    }
  });

  aggForeign.net = aggForeign.buy - aggForeign.sell;
  aggRetail.net = aggRetail.buy - aggRetail.sell;
  aggLocal.net = aggLocal.buy - aggLocal.sell;

  // Determine backfill status for Partial Data
  const isIncomplete = completeness < 0.7;

  return {
    backfill_active: isIncomplete ? true : false,
    completeness: completeness,
    history: results,
    summary: {
      top_buyers: format('bval'),
      top_sellers: format('sval'),
      top_net_buyers: allNet.filter(b => b.net > 0).sort((a, b) => b.net - a.net).slice(0, 20),
      top_net_sellers: allNet.filter(b => b.net < 0).sort((a, b) => a.net - b.net).slice(0, 20),
      // Added Aggregates for Frontend Summary
      foreign: { buy_val: aggForeign.buy, sell_val: aggForeign.sell, net_val: aggForeign.net },
      retail: { buy_val: aggRetail.buy, sell_val: aggRetail.sell, net_val: aggRetail.net },
      local: { buy_val: aggLocal.buy, sell_val: aggLocal.sell, net_val: aggLocal.net }
    }
  };
}

// ==============================
// Worker Entry
// ==============================
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      console.log(`[API-SAHAM] Request: ${req.method} ${url.pathname} (v2026-02-04)`);

      // CORS
      if (req.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));

      // 0. GET /footprint/summary (Hybrid Bubble Chart - Static Live)
      if (url.pathname === "/footprint/summary" && req.method === "GET") {
        // WEEKEND FALLBACK: Check if today is weekend and fallback to last trading day's summary
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        let key = "features/footprint-summary.json";
        let object = await env.SSSAHAM_EMITEN.get(key);

        // Parse the existing object to check if it's empty
        let isEmpty = !object;
        let cachedData = null;
        if (object) {
          try {
            cachedData = await object.json();
            isEmpty = !cachedData.items || cachedData.items.length === 0;
          } catch (e) {
            isEmpty = true;
          }
        }

        // If empty (weekend or no data), search back up to 7 days for last available data
        if (isEmpty) {
          console.log(`[SUMMARY] Empty or weekend (day=${dayOfWeek}), searching DB for recent data...`);

          // Try up to 7 days back to find last trading day with data
          for (let daysBack = 1; daysBack <= 7; daysBack++) {
            const tryDate = new Date(now);
            tryDate.setDate(tryDate.getDate() - daysBack);
            const tryDay = tryDate.getDay();
            // Skip weekends
            if (tryDay === 0 || tryDay === 6) continue;

            const tryDateStr = tryDate.toISOString().split("T")[0];
            console.log(`[SUMMARY] Trying fallback date: ${tryDateStr} (${daysBack} days back)`);

            try {
              const rangeData = await calculateFootprintRange(env, tryDateStr, tryDateStr);
              if (rangeData && rangeData.items && rangeData.items.length > 0) {
                return json({
                  version: "v3.0-hybrid",
                  generated_at: new Date().toISOString(),
                  date: tryDateStr,
                  count: rangeData.items.length,
                  status: "FALLBACK",
                  reason: `Using ${tryDateStr} (${daysBack} day${daysBack > 1 ? 's' : ''} ago)`,
                  items: rangeData.items
                }, 200, { "Cache-Control": "public, max-age=300" }); // 5min cache for fallback
              }
            } catch (e) {
              console.error(`[SUMMARY] Fallback ${tryDateStr} failed:`, e.message);
            }
          }

          // Final fallback: return empty with message
          return json({
            version: "v3.0-hybrid",
            status: "NO_DATA",
            reason: isWeekend ? "WEEKEND_NO_DATA" : "NO_DATA",
            message: isWeekend ? "No trading data available for weekend. Market closed." : "No data available. No recent trading data found in last 7 days.",
            items: []
          }, 200);
        }

        // Normal case: return cached data
        const headers = new Headers();
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate"); // Force fresh on every request
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Content-Type", "application/json");

        return new Response(JSON.stringify(cachedData), { headers });
      }

      // 0.5 GET /footprint/range (Hybrid Bubble Chart - Date Range)
      if (url.pathname === "/footprint/range" && req.method === "GET") {
        const fromDate = url.searchParams.get("from");
        const toDate = url.searchParams.get("to");

        if (!fromDate || !toDate) return json({ error: "Missing from/to params" }, 400);

        try {
          const data = await calculateFootprintRange(env, fromDate, toDate);
          return json(data, 200, { "Cache-Control": "public, max-age=60" });
        } catch (e) {
          return json({ error: "Aggregation failed", details: e.message }, 500);
        }
      }

      // NEW: GET /footprint-raw-hist?kode=BBRI&date=2026-02-06
      if (url.pathname === "/footprint-raw-hist" && req.method === "GET") {
        const kode = url.searchParams.get("kode");
        let dateStr = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
        if (!kode) return json({ error: "Missing kode" }, 400);

        // WEEKEND FALLBACK: If requested date is weekend, fallback to Friday
        const requestedDate = new Date(dateStr);
        const dayOfWeek = requestedDate.getDay(); // 0 = Sunday, 6 = Saturday
        if (dayOfWeek === 0) { // Sunday -> Friday
          requestedDate.setDate(requestedDate.getDate() - 2);
          dateStr = requestedDate.toISOString().split("T")[0];
          console.log(`[API] Weekend fallback: Sunday -> ${dateStr}`);
        } else if (dayOfWeek === 6) { // Saturday -> Friday
          requestedDate.setDate(requestedDate.getDate() - 1);
          dateStr = requestedDate.toISOString().split("T")[0];
          console.log(`[API] Weekend fallback: Saturday -> ${dateStr}`);
        }

        try {
          const [y, m, d] = dateStr.split("-");

          // GENERATE KEYS FOR 00-23 UTC
          const hourKeys = [];
          for (let h = 0; h <= 23; h++) {
            const hStr = h.toString().padStart(2, "0");
            // Correct format using slashes: footprint/KODE/1m/YYYY/MM/DD/HH.jsonl
            hourKeys.push({ h: hStr, key: `footprint/${kode}/1m/${y}/${m}/${d}/${hStr}.jsonl` });
          }

          console.log(`[API] Fetching all segments (00-23 UTC) for ${kode} @ ${dateStr}`);

          // PARALLEL FETCH
          const segments = await Promise.all(
            hourKeys.map(async ({ h, key }) => {
              const obj = await env.FOOTPRINT_BUCKET.get(key);
              if (!obj) {
                console.log(`[R2] MISSING: ${key}`);
                return [];
              }

              const text = await obj.text();
              console.log(`[R2] FOUND: ${key} (${text.length} bytes), first 100 chars: ${text.substring(0, 100)}`);

              const lines = text.split("\n").filter(l => l.trim());
              const candles = [];
              lines.forEach(line => {
                try { candles.push(JSON.parse(line)); } catch (e) {
                  console.error(`[API] JSON Parse Error in ${key}:`, e.message);
                }
              });
              return candles;
            })
          );

          const allCandles = segments.flat();

          // ========================================
          // THOUGHT PROCESS LOGGING (Smart Completion)
          // ========================================
          const now = new Date();
          const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
          const todayWIBStr = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth() + 1).padStart(2, '0')}-${String(nowWIB.getDate()).padStart(2, '0')}`;
          const dayOfWeek = nowWIB.getDay(); // 0=Sun, 6=Sat
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          const isToday = dateStr === todayWIBStr;
          const nowHour = nowWIB.getHours();
          const nowMin = nowWIB.getMinutes();

          console.log(`\n========== [THOUGHT PROCESS] ${kode} @ ${dateStr} ==========`);
          console.log(`[🕐 NOW] Today is ${todayWIBStr} (${dayNames[dayOfWeek]}), Time: ${nowHour}:${String(nowMin).padStart(2, '0')} WIB`);
          console.log(`[📅 CONTEXT] Today is ${isWeekend ? 'WEEKEND' : 'WEEKDAY'}`);
          console.log(`[📊 REQUEST] User requested data for: ${dateStr} (${isToday ? 'TODAY' : 'PAST DAY'})`);
          console.log(`[📁 R2 FETCH] Found ${allCandles.length} candles from ${hourKeys.length} hour segments`);

          // PHASE 3: Smart Completion Check
          const completion = checkDataCompleteness(allCandles, dateStr);
          const isIncomplete = completion.isIncomplete;

          // Show last candle info
          if (allCandles.length > 0) {
            const lastCandle = allCandles[allCandles.length - 1];
            const lastCandleWIB = new Date(new Date(lastCandle.t0).toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
            const lastH = lastCandleWIB.getHours();
            const lastM = lastCandleWIB.getMinutes();
            console.log(`[📈 CHART] Last candle at ${lastH}:${String(lastM).padStart(2, '0')} WIB`);
            if (!isToday) {
              console.log(`[📈 CHART] For past day, market close is 15:50 WIB. Last candle ${lastH >= 15 && lastM >= 50 ? 'REACHES' : 'DOES NOT REACH'} market close`);
            } else {
              console.log(`[📈 CHART] For today, expecting data up to ~${nowHour}:${String(nowMin).padStart(2, '0')} WIB`);
            }
          }

          // SKELETAL DETECTION
          let isBroken = false;
          if (allCandles.length > 0) {
            let sampled = 0;
            for (const c of allCandles) {
              if (c.vol > 0) {
                if (!c.levels || c.levels.length === 0) {
                  isBroken = true;
                  break;
                }
                sampled++;
                if (sampled >= 10) break;
              }
            }
          }

          console.log(`[🔍 DATA QUALITY] Skeletal/Broken: ${isBroken ? 'YES ❌' : 'NO ✅'}`);
          console.log(`[🔍 DATA QUALITY] Incomplete: ${isIncomplete ? `YES ❌ (${completion.reason})` : 'NO ✅'}`);
          console.log(`[📊 TABLE] Expected: ${isToday ? '1 row per traded minute so far' : '~200-300 rows for full day'}. Actual: ${allCandles.length} rows`);
          console.log(`[📊 TABLE] Status: ${allCandles.length >= 20 || (isToday && allCandles.length >= 3) ? 'LIKELY OK ✅' : 'SPARSE ⚠️'}`);

          // FALLBACK LOGIC
          let isFallback = false;
          let fallbackData = null;
          let fallbackLevel1Status = 'NOT_CHECKED';
          let fallbackLevel2Status = 'NOT_CHECKED';

          if (isBroken || allCandles.length === 0 || isIncomplete) {
            console.log(`[🔄 FALLBACK] Triggering fallback due to: ${isBroken ? 'BROKEN' : ''} ${allCandles.length === 0 ? 'EMPTY' : ''} ${isIncomplete ? `INCOMPLETE(${completion.reason})` : ''}`);

            // PRIORITY 1: saham/processed/KODE/intraday.json
            const p1Key = `processed/${kode}/intraday.json`;
            const p1Obj = await env.SSSAHAM_EMITEN.get(p1Key);
            if (p1Obj) {
              fallbackData = await p1Obj.json();
              isFallback = true;
              fallbackLevel1Status = 'FOUND ✅';
              console.log(`[🔄 FALLBACK] Level 1: ${p1Key} -> FOUND ✅`);
            } else {
              fallbackLevel1Status = 'NOT_FOUND ❌';
              console.log(`[🔄 FALLBACK] Level 1: ${p1Key} -> NOT FOUND ❌`);

              // PRIORITY 2: tape-data-saham/processed/YYYY-MM-DD.json
              const p2Key = `processed/${dateStr}.json`;
              const p2Obj = await env.FOOTPRINT_BUCKET.get(p2Key);
              if (p2Obj) {
                const fullDaily = await p2Obj.json();
                const tickerData = (fullDaily.items || []).find(item => item.t === kode);
                if (tickerData) {
                  fallbackData = tickerData;
                  isFallback = true;
                  fallbackLevel2Status = 'FOUND ✅';
                  console.log(`[🔄 FALLBACK] Level 2: ${p2Key} (ticker: ${kode}) -> FOUND ✅`);
                } else {
                  fallbackLevel2Status = 'TICKER_NOT_IN_FILE ❌';
                  console.log(`[🔄 FALLBACK] Level 2: ${p2Key} exists but ${kode} not in items -> NOT FOUND ❌`);
                }
              } else {
                fallbackLevel2Status = 'FILE_NOT_FOUND ❌';
                console.log(`[🔄 FALLBACK] Level 2: ${p2Key} -> NOT FOUND ❌`);
              }
            }
          } else {
            console.log(`[🔄 FALLBACK] Not needed - data is complete ✅`);
          }

          // REPAIR TRIGGER (Asynchronous) - Only for truly incomplete data, NOT sparse stocks
          // SPARSE_DATA is a stock characteristic, not broken data
          const shouldRepair = isBroken || allCandles.length === 0 || (isIncomplete && completion.reason !== 'SPARSE_DATA');
          if (shouldRepair) {
            const isHighPriority = isIncomplete && allCandles.length > 0;
            const repairUrl = `https://livetrade-taping-agregator.mkemalw.workers.dev/repair-footprint?kode=${kode}&date=${dateStr}${isHighPriority ? '&priority=high' : ''}`;
            console.log(`[🔧 REPAIR] Triggering ${isHighPriority ? 'HIGH PRIORITY' : 'NORMAL'} repair: ${repairUrl}`);
            if (typeof ctx !== "undefined" && ctx.waitUntil) {
              ctx.waitUntil(fetch(repairUrl, { method: "POST" }).catch(e => console.error("[REPAIR] Trigger failed:", e.message)));
            } else {
              fetch(repairUrl, { method: "POST" }).catch(e => console.error("[REPAIR] Trigger failed:", e.message));
            }
          } else {
            console.log(`[🔧 REPAIR] Not needed${completion.reason === 'SPARSE_DATA' ? ' (sparse stock, not broken)' : ''}`);
          }

          // is_repairing should be false for SPARSE_DATA (sparse stocks are normal, not broken)
          const isRepairing = isBroken || allCandles.length === 0 || (isIncomplete && !isFallback && completion.reason !== 'SPARSE_DATA');
          console.log(`[📤 RESPONSE] is_fallback: ${isFallback}, is_repairing: ${isRepairing}`);
          console.log(`========== [END THOUGHT PROCESS] ==========\n`);

          if (allCandles.length === 0 && !isFallback) return json({ status: "OK", buckets: [], history: [], candles: [], is_repairing: true });

          // RESOLUTION: 1-minute (direct from R2) to ensure alignment for CASA/sparse data
          allCandles.sort((a, b) => a.t0 - b.t0);

          const history = [];
          const tableData = [];
          const candles = [];

          // If fallback is found, we'll map its timeline to our result
          // fallbackData.timeline: [ { t: "09:00", p: 1325, v: 112, m: 50, a: 0 }, ... ]
          const fallbackTimelineMap = new Map();
          if (isFallback && fallbackData && fallbackData.timeline) {
            fallbackData.timeline.forEach(entry => {
              fallbackTimelineMap.set(entry.t, entry);
            });
          }

          allCandles.forEach(c => {
            const dateObj = new Date(c.t0);
            const timeStr = dateObj.toLocaleTimeString('en-GB', {
              hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
            });

            // Chart candle
            const open = c.ohlc.o;
            const close = c.ohlc.c;
            const pricePct = open > 0 ? ((close - open) / open) * 100 : 0;
            const absCvd = c.vol > 0 ? Math.abs(c.delta / c.vol) * 100 / (1 + Math.abs(pricePct)) : 0;

            candles.push({ x: c.t0, o: open, h: c.ohlc.h, l: c.ohlc.l, c: close });

            // Table Summary (1 row per minute)
            tableData.push({
              t: timeStr,
              x: c.t0,
              p: close,
              v: c.vol,
              a: c.delta,
              m: c.vol > 0 ? Number(((c.delta / c.vol) * 50 + 50).toFixed(2)) : 50, // Haka/Haki balance
              abs: Number(absCvd.toFixed(2))
            });

            // Table buckets / bubbles (Granular)
            if (c.levels && c.levels.length > 0) {
              c.levels.forEach(lvl => {
                const totalV = lvl.bv + lvl.av;
                if (totalV > 0) {
                  const buyRatio = (lvl.bv / totalV) * 100;
                  const delta = lvl.bv - lvl.av;

                  history.push({
                    t: timeStr,
                    x: c.t0,
                    p: lvl.p,
                    v: totalV,
                    bv: lvl.bv,
                    av: lvl.av,
                    side: lvl.bv >= lvl.av ? 'buy' : 'sell'
                  });
                }
              });
            } else if (isFallback && fallbackTimelineMap.has(timeStr)) {
              // Inject fallback bubble for this minute
              const f = fallbackTimelineMap.get(timeStr);
              history.push({
                t: timeStr,
                x: c.t0,
                p: f.p,
                v: f.v,
                m: f.m,
                a: f.a,
                is_fallback: true,
                side: f.a >= 0 ? 'buy' : 'sell'
              });
            } else if (c.vol > 0) {
              // Fallback: Create a bubble from candle OHLC data when no levels exist
              // This ensures sparse stocks still show their data points
              history.push({
                t: timeStr,
                x: c.t0,
                p: close, // Use close price as bubble center
                v: c.vol,
                bv: c.delta > 0 ? (c.vol + c.delta) / 2 : c.vol / 2,
                av: c.delta < 0 ? (c.vol - c.delta) / 2 : c.vol / 2,
                side: c.delta >= 0 ? 'buy' : 'sell',
                is_synthetic: true // Mark as synthetic for debugging
              });
            }
          });

          return json({
            status: "OK",
            buckets: history,
            tableData: tableData,
            candles,
            is_repairing: isRepairing,
            is_fallback: isFallback
          });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // NEW: GET /symbol?kode=BBRI&mode=footprint
      if (url.pathname === "/symbol" && req.method === "GET") {
        const kode = url.searchParams.get("kode");
        if (!kode) return json({ error: "Missing kode" }, 400);

        try {
          // 1. Determine Date (Last trading day or Today)
          const latestRow = await env.SSSAHAM_DB.prepare(
            "SELECT MAX(date) as last_date FROM temp_footprint_consolidate WHERE ticker = ?"
          ).bind(kode).first();
          const dateStr = latestRow?.last_date || new Date().toISOString().split("T")[0];
          const [y, m, d] = dateStr.split("-");

          // 2. Fetch Granular Footprint from R2 (00-23 UTC)
          const hourKeys = [];
          for (let h = 0; h <= 23; h++) {
            const hStr = h.toString().padStart(2, "0");
            hourKeys.push(`footprint/${kode}/1m/${y}/${m}/${d}/${hStr}.jsonl`);
          }

          const segments = await Promise.all(
            hourKeys.map(async (key) => {
              const obj = await env.FOOTPRINT_BUCKET.get(key);
              if (!obj) return [];
              const text = await obj.text();
              const lines = text.split("\n").filter(l => l.trim());
              const candles = [];
              lines.forEach(line => {
                try { candles.push(JSON.parse(line)); } catch (e) { }
              });
              return candles;
            })
          );
          const allCandles = segments.flat();

          // PHASE 3: Smart Completion Check
          const completion = checkDataCompleteness(allCandles, dateStr);
          const isIncomplete = completion.isIncomplete;

          // SKELETAL DETECTION
          let isBroken = false;
          if (allCandles.length > 0) {
            let sampled = 0;
            for (const c of allCandles) {
              if (c.vol > 0) {
                if (!c.levels || c.levels.length === 0) {
                  isBroken = true;
                  break;
                }
                sampled++;
                if (sampled >= 10) break;
              }
            }
          }

          // FALLBACK LOGIC
          let isFallback = false;
          let fallbackData = null;

          if (isBroken || allCandles.length === 0 || isIncomplete) {
            console.log(`[SYMBOL] Fallback triggered for ${kode}: broken=${isBroken}, empty=${allCandles.length === 0}, incomplete=${isIncomplete} (${completion.reason})`);
            const p1Key = `processed/${kode}/intraday.json`;
            const p1Obj = await env.SSSAHAM_EMITEN.get(p1Key);
            if (p1Obj) {
              fallbackData = await p1Obj.json();
              isFallback = true;
            } else {
              const p2Key = `processed/${dateStr}.json`;
              const p2Obj = await env.FOOTPRINT_BUCKET.get(p2Key);
              if (p2Obj) {
                const fullDaily = await p2Obj.json();
                const tickerData = (fullDaily.items || []).find(item => item.t === kode);
                if (tickerData) {
                  fallbackData = tickerData;
                  isFallback = true;
                }
              }
            }
          }

          // REPAIR TRIGGER (Asynchronous)
          if (isBroken || allCandles.length === 0 || isIncomplete) {
            const isHighPriority = isIncomplete && allCandles.length > 0;
            const repairUrl = `https://livetrade-taping-agregator.mkemalw.workers.dev/repair-footprint?kode=${kode}&date=${dateStr}${isHighPriority ? '&priority=high' : ''}`;
            if (typeof ctx !== "undefined" && ctx.waitUntil) {
              ctx.waitUntil(fetch(repairUrl, { method: "POST" }).catch(e => { }));
            } else {
              fetch(repairUrl, { method: "POST" }).catch(e => { });
            }
          }

          if (allCandles.length === 0 && !isFallback) {
            return json({ snapshot: { ticker: kode, date: dateStr, history: [] }, state: null, is_repairing: true });
          }

          // 3. Aggregate 1m -> 5m buckets
          allCandles.sort((a, b) => a.t0 - b.t0);

          const buckets = new Map(); // timeKey5m -> { t0, levels: Map<p, {bv, av}>, o, h, l, c, vol, delta }

          allCandles.forEach(c => {
            const t0_5m = Math.floor(c.t0 / 300000) * 300000;
            if (!buckets.has(t0_5m)) {
              buckets.set(t0_5m, {
                t0: t0_5m,
                levels: new Map(),
                o: c.ohlc.o, h: c.ohlc.h, l: c.ohlc.l, c: c.ohlc.c,
                vol: 0, delta: 0
              });
            }
            const b = buckets.get(t0_5m);
            b.h = Math.max(b.h, c.ohlc.h);
            b.l = Math.min(b.l, c.ohlc.l);
            b.c = c.ohlc.c;
            b.vol += c.vol;
            b.delta += c.delta;

            if (c.levels && c.levels.length > 0) {
              c.levels.forEach(lvl => {
                if (!b.levels.has(lvl.p)) b.levels.set(lvl.p, { p: lvl.p, bv: 0, av: 0 });
                const bl = b.levels.get(lvl.p);
                bl.bv += lvl.bv;
                bl.av += lvl.av;
              });
            } else if (isFallback && fallbackData && fallbackData.timeline) {
              // Try to find matching time in fallback timeline
              const dateObj = new Date(c.t0);
              const timeStr = dateObj.toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
              });
              const f = fallbackData.timeline.find(entry => entry.t === timeStr);
              if (f) {
                if (!b.levels.has(f.p)) b.levels.set(f.p, { p: f.p, bv: 0, av: 0, is_fallback: true });
                const bl = b.levels.get(f.p);
                // Fallback often only provides total vol and delta, we have to estimate bv/av
                // f.v is total vol, f.a is delta
                // bv + av = v
                // bv - av = a
                // 2bv = v + a -> bv = (v + a) / 2
                const bv = (f.v + f.a) / 2;
                const av = f.v - bv;
                bl.bv += bv;
                bl.av += av;
              }
            }
          });

          // 4. Final Data Prep for Frontend
          const history = []; // Bubbles: { t, p, v, bv, av, side }
          const candles = []; // Candlesticks: { x, o, h, l, c }

          const sortedBuckets = Array.from(buckets.values()).sort((a, b) => a.t0 - b.t0);

          sortedBuckets.forEach(b => {
            const timeStr = new Date(b.t0).toLocaleTimeString('en-GB', {
              hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
            });

            // Add Candle
            candles.push({
              x: b.t0,
              o: b.o,
              h: b.h,
              l: b.l,
              c: b.c
            });

            // Add Bubbles at Price Levels
            b.levels.forEach(lvl => {
              const totalV = lvl.bv + lvl.av;
              if (totalV > 0) {
                history.push({
                  t: timeStr,
                  x: b.t0, // Link bubble to candle timestamp
                  p: lvl.p,
                  v: totalV,
                  bv: lvl.bv,
                  av: lvl.av,
                  side: lvl.bv >= lvl.av ? 'buy' : 'sell'
                });
              }
            });
          });

          // 5. Snapshot Stats (Lightweight)
          // Just get basic stats from D1 for the snapshot
          const lastHist = await env.SSSAHAM_DB.prepare(
            "SELECT * FROM temp_footprint_consolidate WHERE ticker = ? AND date = ? ORDER BY time_key DESC LIMIT 1"
          ).bind(kode, dateStr).first();

          const dayStats = await env.SSSAHAM_DB.prepare(
            "SELECT MIN(low) as low, MAX(high) as high, SUM(vol) as vol, SUM(delta) as net_vol, " +
            "(SELECT open FROM temp_footprint_consolidate WHERE ticker = ? AND date = ? ORDER BY time_key ASC LIMIT 1) as open " +
            "FROM temp_footprint_consolidate WHERE ticker = ? AND date = ?"
          ).bind(kode, dateStr, kode, dateStr).first();

          const snapshot = {
            ticker: kode,
            date: dateStr,
            close: lastHist?.close || 0,
            open: dayStats?.open || 0,
            high: dayStats?.high || 0,
            low: dayStats?.low || 0,
            vol: dayStats?.vol || 0,
            net_vol: dayStats?.net_vol || 0,
            haka_pct: dayStats ? parseFloat((((dayStats.net_vol / dayStats.vol) * 100 + 100) / 2).toFixed(1)) : 50,
            fluktuasi: (dayStats && dayStats.open > 0) ? parseFloat((((lastHist.close - dayStats.open) / dayStats.open) * 100).toFixed(2)) : 0,
            history: [] // Limited history or empty, chart uses /footprint-raw-hist
          };

          const stateRow = await env.SSSAHAM_DB.prepare(`
            SELECT state as quadrant_st, score
            FROM daily_features
            WHERE ticker = ? 
            ORDER BY date DESC LIMIT 1
          `).bind(kode).first();

          return json({
            snapshot,
            state: stateRow ? {
              quadrant: stateRow.quadrant_st === 'ACCUMULATION' ? 1 : (stateRow.quadrant_st === 'DISTRIBUTION' ? 3 : 2),
              score: stateRow.score
            } : null,
            // is_repairing should be false for SPARSE_DATA (sparse stocks are normal, not broken)
            is_repairing: isBroken || allCandles.length === 0 || (isIncomplete && !isFallback && completion.reason !== 'SPARSE_DATA'),
            is_fallback: isFallback
          });

        } catch (e) {
          return json({ error: "Fetch symbol (R2) failed", details: e.message }, 500);
        }
      }

      // 1. GET /screener
      if (url.pathname === "/screener" && req.method === "GET") {
        try {
          // Fetch Pointer
          const pointerObj = await env.SSSAHAM_EMITEN.get("features/latest.json");
          if (!pointerObj) return json({ items: [] });

          let data = await pointerObj.json();

          // Check if it is a pointer (has pointer_to)
          if (data.pointer_to) {
            const actualObj = await env.SSSAHAM_EMITEN.get(data.pointer_to);
            if (!actualObj) return json({ items: [] });
            data = await actualObj.json();
          }

          return withCORS(new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch screener", details: e.message }, 500);
        }
      }

      // GET /foreign-flow-scanner - Returns pre-computed foreign flow trend data
      if (url.pathname === "/foreign-flow-scanner" && req.method === "GET") {
        try {
          const obj = await env.SSSAHAM_EMITEN.get("features/foreign-flow-scanner.json");
          if (!obj) return json({ items: [], error: "No data. Run /foreign-flow-scanner on features-service first." });
          const data = await obj.json();
          return withCORS(new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch foreign flow scanner", details: e.message }, 500);
        }
      }

      // GET /screener-mvp - Returns screener filtered by last 2 days foreign+local positive
      if (url.pathname === "/screener-mvp" && req.method === "GET") {
        try {
          const CACHE_VERSION = 'v2'; // Bump to invalidate cache
          const CACHE_TTL_SECONDS = 3600; // 1 hour
          const FOREIGN_CODES = new Set(['ZP', 'YU', 'KZ', 'RX', 'BK', 'AK', 'CS', 'CG', 'DB', 'ML', 'CC', 'DX', 'FS', 'LG', 'NI', 'OD']);
          
          // Check cache first
          const cacheKey = `cache/screener-mvp-${CACHE_VERSION}.json`;
          const cachedObj = await env.SSSAHAM_EMITEN.get(cacheKey);
          
          if (cachedObj) {
            const cached = await cachedObj.json();
            const cacheAge = (Date.now() - (cached.timestamp || 0)) / 1000;
            if (cacheAge < CACHE_TTL_SECONDS) {
              return withCORS(new Response(JSON.stringify({
                ...cached.data,
                cached: true,
                cacheAge: Math.round(cacheAge)
              }), { headers: { "Content-Type": "application/json" } }));
            }
          }
          
          // Fetch screener data
          const pointerObj = await env.SSSAHAM_EMITEN.get("features/latest.json");
          if (!pointerObj) return json({ items: [] });
          let screenerData = await pointerObj.json();
          if (screenerData.pointer_to) {
            const actualObj = await env.SSSAHAM_EMITEN.get(screenerData.pointer_to);
            if (!actualObj) return json({ items: [] });
            screenerData = await actualObj.json();
          }
          
          // Get last 2 trading days (skip today as data may be incomplete)
          const dates = [];
          const today = new Date();
          for (let i = 1; i < 10 && dates.length < 2; i++) { // Start from yesterday (i=1)
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) {
              dates.push(d.toISOString().split('T')[0]);
            }
          }
          
          // Filter stocks by last 2 days foreign+local positive
          const filteredItems = [];
          const brokersMap = {};
          
          // Fetch brokers mapping
          try {
            const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
            if (results) results.forEach(b => brokersMap[b.code] = b);
          } catch (e) {}
          
          const isRetail = (code) => {
            const b = brokersMap[code];
            if (!b) return false;
            return (b.category || '').toLowerCase().includes('retail');
          };
          
          for (const item of screenerData.items || []) {
            const ticker = item.t;
            let passFilter = true;
            let flowData = { day1: null, day2: null };
            
            for (let dayIdx = 0; dayIdx < dates.length && passFilter; dayIdx++) {
              const dateStr = dates[dayIdx];
              try {
                const key = `${ticker}/${dateStr}.json`;
                const obj = await env.RAW_BROKSUM.get(key);
                if (!obj) { passFilter = false; continue; }
                
                const fileData = await obj.json();
                const bs = fileData?.data?.broker_summary;
                if (!bs) { passFilter = false; continue; }
                
                let foreignBuy = 0, foreignSell = 0;
                let localBuy = 0, localSell = 0;
                
                if (bs.brokers_buy && Array.isArray(bs.brokers_buy)) {
                  bs.brokers_buy.forEach(b => {
                    if (!b) return;
                    const val = parseFloat(b.bval) || 0;
                    const code = b.netbs_broker_code;
                    if (b.type === 'Asing' || FOREIGN_CODES.has(code)) foreignBuy += val;
                    else if (!isRetail(code)) localBuy += val;
                  });
                }
                
                if (bs.brokers_sell && Array.isArray(bs.brokers_sell)) {
                  bs.brokers_sell.forEach(b => {
                    if (!b) return;
                    const val = parseFloat(b.sval) || 0;
                    const code = b.netbs_broker_code;
                    if (b.type === 'Asing' || FOREIGN_CODES.has(code)) foreignSell += val;
                    else if (!isRetail(code)) localSell += val;
                  });
                }
                
                const foreignNet = foreignBuy - foreignSell;
                const localNet = localBuy - localSell;
                
                // Filter: foreign AND local must be positive (smart money inflow)
                if (foreignNet <= 0 || localNet <= 0) {
                  passFilter = false;
                }
                
                if (dayIdx === 0) flowData.day1 = { foreign: foreignNet, local: localNet, date: dateStr };
                else flowData.day2 = { foreign: foreignNet, local: localNet, date: dateStr };
                
              } catch (e) {
                passFilter = false;
              }
            }
            
            if (passFilter && flowData.day1 && flowData.day2) {
              filteredItems.push({
                ...item,
                flow: flowData
              });
            }
          }
          
          const responseData = {
            items: filteredItems,
            date: screenerData.date,
            filter: 'foreign+local > 0 last 2 days',
            total: filteredItems.length
          };
          
          // Store in cache
          try {
            await env.SSSAHAM_EMITEN.put(cacheKey, JSON.stringify({
              timestamp: Date.now(),
              data: responseData
            }));
          } catch (e) {}
          
          return withCORS(new Response(JSON.stringify({
            ...responseData,
            cached: false
          }), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch screener-mvp", details: e.message }, 500);
        }
      }

      // GET /screener-accum - Returns pre-aggregated accumulation scanner data
      // Artifact built by accum-preprocessor cron in broksum-scrapper
      // Supports ?window=2|5|10|20 (default: 2) for server-side pre-filter
      if (url.pathname === "/screener-accum" && req.method === "GET") {
        try {
          const cacheKey = "cache/screener-accum-latest.json";
          const obj = await env.SSSAHAM_EMITEN.get(cacheKey);
          if (!obj) {
            return json({ items: [], error: "Accumulation data not yet generated. Cron runs at 19:15 WIB." });
          }

          const accumData = await obj.json();
          const requestedWindow = parseInt(url.searchParams.get('window') || '2');
          const validWindows = [2, 5, 10, 20];
          const window = validWindows.includes(requestedWindow) ? requestedWindow : 2;

          // Merge with screener z-score data for enriched response
          let screenerMap = {};
          try {
            const pointerObj = await env.SSSAHAM_EMITEN.get("features/latest.json");
            if (pointerObj) {
              let screenerData = await pointerObj.json();
              if (screenerData.pointer_to) {
                const actualObj = await env.SSSAHAM_EMITEN.get(screenerData.pointer_to);
                if (actualObj) screenerData = await actualObj.json();
              }
              for (const item of (screenerData.items || [])) {
                screenerMap[item.t] = item;
              }
            }
          } catch (e) {
            console.error("[screener-accum] Failed to load z-score data:", e);
          }

          // Build enriched items: accum metrics + z-score data
          const items = [];
          for (const row of (accumData.items || [])) {
            const windowData = row.accum?.[window];
            if (!windowData) continue;

            const screenerItem = screenerMap[row.t] || null;

            items.push({
              t: row.t,
              // Accum data for requested window
              accum: {
                fn: windowData.fn,   // foreign net
                ln: windowData.ln,   // local net
                rn: windowData.rn,   // retail net
                sm: windowData.sm,   // smart money (fn+ln)
                streak: windowData.streak, // consecutive sm>0 days
                allPos: windowData.allPos, // every day sm>0
                pctChg: windowData.pctChg, // price change %
                window: window
              },
              // Z-score data (if available)
              s: screenerItem?.s || null,
              sc: screenerItem?.sc || null,
              z: screenerItem?.z || null
            });
          }

          return withCORS(new Response(JSON.stringify({
            items,
            date: accumData.date,
            generatedAt: accumData.generatedAt,
            window,
            availableWindows: validWindows,
            total: items.length
          }), { headers: { "Content-Type": "application/json" } }));

        } catch (e) {
          return json({ error: "Failed to fetch screener-accum", details: e.message }, 500);
        }
      }

      // GET /foreign-sentiment - Returns foreign gross flow for MVP 10 stocks
      // Cached in R2 with 1 hour TTL
      if (url.pathname === "/foreign-sentiment" && req.method === "GET") {
        try {
          const CACHE_VERSION = 'v1'; // Bump this when logic changes
          const CACHE_TTL_SECONDS = 3600; // 1 hour
          const MVP_TICKERS = ['BREN', 'BBCA', 'DSSA', 'BBRI', 'TPIA', 'AMMN', 'BYAN', 'DCII', 'BMRI', 'TLKM'];
          const FOREIGN_CODES = new Set(['ZP', 'YU', 'KZ', 'RX', 'BK', 'AK', 'CS', 'CG', 'DB', 'ML', 'CC', 'DX', 'FS', 'LG', 'NI', 'OD']);
          const days = Math.min(parseInt(url.searchParams.get('days') || '7'), 90); // Max 90 days
          
          // Check cache first
          const cacheKey = `cache/foreign-sentiment-${days}d-${CACHE_VERSION}.json`;
          const cachedObj = await env.SSSAHAM_EMITEN.get(cacheKey);
          
          if (cachedObj) {
            const cached = await cachedObj.json();
            const cacheAge = (Date.now() - (cached.timestamp || 0)) / 1000;
            
            if (cacheAge < CACHE_TTL_SECONDS) {
              // Return cached data
              return withCORS(new Response(JSON.stringify({
                ...cached.data,
                cached: true,
                cacheAge: Math.round(cacheAge)
              }), { headers: { "Content-Type": "application/json" } }));
            }
          }
          
          // Generate date list (trading days only)
          const dates = [];
          const today = new Date();
          for (let i = 0; i < days + Math.ceil(days * 0.5); i++) { // Extra buffer for weekends
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) { // Skip weekends
              dates.push(d.toISOString().split('T')[0]);
            }
            if (dates.length >= days) break;
          }
          
          const result = {};
          
          // Fetch data for each ticker
          for (const ticker of MVP_TICKERS) {
            const tickerData = [];
            
            for (const dateStr of dates) {
              try {
                const key = `${ticker}/${dateStr}.json`;
                const obj = await env.RAW_BROKSUM.get(key);
                if (!obj) continue;
                
                const fileData = await obj.json();
                const bs = fileData?.data?.broker_summary;
                if (!bs) continue;
                
                let foreignBuy = 0, foreignSell = 0;
                
                // Process buyers
                if (bs.brokers_buy && Array.isArray(bs.brokers_buy)) {
                  bs.brokers_buy.forEach(b => {
                    if (b && (b.type === 'Asing' || FOREIGN_CODES.has(b.netbs_broker_code))) {
                      foreignBuy += parseFloat(b.bval) || 0;
                    }
                  });
                }
                
                // Process sellers
                if (bs.brokers_sell && Array.isArray(bs.brokers_sell)) {
                  bs.brokers_sell.forEach(b => {
                    if (b && (b.type === 'Asing' || FOREIGN_CODES.has(b.netbs_broker_code))) {
                      foreignSell += parseFloat(b.sval) || 0;
                    }
                  });
                }
                
                tickerData.push({
                  date: dateStr,
                  buy: foreignBuy,
                  sell: foreignSell,
                  net: foreignBuy - foreignSell
                });
              } catch (e) {
                // Skip missing data
              }
            }
            
            // Sort by date ascending
            tickerData.sort((a, b) => a.date.localeCompare(b.date));
            result[ticker] = tickerData;
          }
          
          // Calculate cumulative total across all tickers per day
          const sortedDates = dates.sort();
          const cumulative = sortedDates.map(dateStr => {
            let totalBuy = 0, totalSell = 0;
            for (const ticker of MVP_TICKERS) {
              const tickerData = result[ticker] || [];
              const day = tickerData.find(d => d.date === dateStr);
              if (day) {
                totalBuy += day.buy;
                totalSell += day.sell;
              }
            }
            return {
              date: dateStr,
              buy: totalBuy,
              sell: totalSell,
              net: totalBuy - totalSell
            };
          });
          
          const responseData = { 
            tickers: MVP_TICKERS,
            data: result,
            cumulative: cumulative,
            dates: sortedDates
          };
          
          // Store in cache (await to ensure it completes)
          try {
            await env.SSSAHAM_EMITEN.put(cacheKey, JSON.stringify({
              timestamp: Date.now(),
              data: responseData
            }));
          } catch (cacheErr) {
            console.error('Cache write failed:', cacheErr);
          }
          
          return withCORS(new Response(JSON.stringify({
            ...responseData,
            cached: false
          }), { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch foreign sentiment", details: e.message }, 500);
        }
      }

      // 1.6 GET /audit/logs - Get scraping logs from D1
      if (url.pathname === "/audit/logs" && req.method === "GET") {
        try {
          const limit = parseInt(url.searchParams.get("limit") || "100");

          if (!env.SSSAHAM_DB) {
            return json({ error: "DB binding missing" }, 500);
          }

          const { results } = await env.SSSAHAM_DB.prepare(
            `SELECT * FROM scraping_logs ORDER BY timestamp DESC LIMIT ?`
          ).bind(limit).all();

          return withCORS(new Response(JSON.stringify(results || []), {
            headers: { "Content-Type": "application/json" }
          }));
        } catch (e) {
          return json({ error: "Failed to fetch logs", details: e.message }, 500);
        }
      }

      // 2. GET /features/history (Per Emiten Z-Score Audit Trail)
      if (url.pathname === "/features/history" && req.method === "GET") {
        const ticker = url.searchParams.get("symbol");
        if (!ticker) return json({ error: "Missing symbol" }, 400);

        try {
          const key = `features/z_score/emiten/${ticker}.json`;
          const obj = await env.SSSAHAM_EMITEN.get(key);
          if (!obj) return json({ error: "No history found" }, 404);
          return withCORS(new Response(obj.body, { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Fetch error", details: e.message }, 500);
        }
      }

      // 2b. GET /features/calculate (On-Demand Z-Score Calculation)
      if (url.pathname === "/features/calculate" && req.method === "GET") {
        const ticker = url.searchParams.get("symbol");
        if (!ticker) return json({ error: "Missing symbol" }, 400);

        try {
          // Strategy 1: Check if data exists in R2 cache (from broker-summary)
          const cacheKey = `broksum/${ticker}/cache.json`;
          const cacheObj = await env.RAW_BROKSUM.get(cacheKey);
          
          let days = [];
          
          if (cacheObj) {
            // Use broker summary cache data
            const cacheData = await cacheObj.json();
            if (cacheData.history && cacheData.history.length >= 5) {
              days = cacheData.history.map(h => ({
                date: h.date,
                total_vol: h.data?.detector?.volume || 0,
                total_delta: (h.data?.foreign?.net_val || 0) + (h.data?.local?.net_val || 0), // Smart money flow
                close: h.data?.price || h.data?.detector?.average || 0
              })).filter(d => d.close > 0);
            }
          }
          
          // Strategy 2: Fallback to D1 footprint data
          if (days.length < 5) {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);
            const startDateStr = startDate.toISOString().split("T")[0];

            const { results } = await env.SSSAHAM_DB.prepare(`
              SELECT date, 
                     SUM(vol) as total_vol, 
                     SUM(delta) as total_delta,
                     MAX(close) as close
              FROM temp_footprint_consolidate
              WHERE ticker = ? AND date >= ?
              GROUP BY date
              ORDER BY date DESC
              LIMIT 20
            `).bind(ticker, startDateStr).all();
            
            if (results && results.length > days.length) {
              days = results;
            }
          }

          if (days.length < 5) {
            return json({ 
              symbol: ticker,
              source: "none",
              message: "Insufficient data for calculation",
              days_found: days.length
            });
          }

          // Sort oldest first
          days.sort((a, b) => new Date(a.date) - new Date(b.date));
          const n = days.length;

          // Effort = avg volume over period
          const avgVol = days.reduce((s, d) => s + (d.total_vol || 0), 0) / n;
          
          // Result = price change from first to last
          const priceChange = days[n-1].close && days[0].close 
            ? ((days[n-1].close - days[0].close) / days[0].close) * 100 
            : 0;

          // Net Quality = avg delta % (how consistent is buying)
          const avgDeltaPct = days.reduce((s, d) => {
            const vol = d.total_vol || 1;
            return s + (d.total_delta / vol) * 100;
          }, 0) / n;

          // Elasticity = price response per unit effort (simplified)
          const elasticity = avgVol > 0 ? priceChange / (avgVol / 1000000) : 0;

          // Determine state based on delta trend
          const recentDelta = days.slice(-5).reduce((s, d) => s + (d.total_delta || 0), 0);
          const earlyDelta = days.slice(0, 5).reduce((s, d) => s + (d.total_delta || 0), 0);
          
          let state = "NEUTRAL";
          if (recentDelta > earlyDelta * 1.5 && recentDelta > 0) state = "ACCUMULATION";
          else if (recentDelta < earlyDelta * 0.5 && recentDelta < 0) state = "DISTRIBUTION";
          else if (recentDelta > 0 && priceChange > 2) state = "READY_MARKUP";
          else if (recentDelta < 0 && priceChange < -2) state = "POTENTIAL_TOP";

          // Normalize to z-score-like values (-3 to +3 range)
          const normalize = (val, min, max) => Math.max(-3, Math.min(3, ((val - min) / (max - min || 1)) * 6 - 3));
          
          const features = {
            effort: normalize(avgVol, 0, 10000000),
            response: normalize(priceChange, -10, 10),
            quality: normalize(avgDeltaPct, -50, 50),
            elasticity: normalize(elasticity, -1, 1),
            state: state
          };

          return json({
            symbol: ticker,
            source: "on_demand",
            days_used: n,
            period: `${days[0].date} to ${days[n-1].date}`,
            features: features,
            raw: {
              avg_volume: Math.round(avgVol),
              price_change_pct: priceChange.toFixed(2),
              avg_delta_pct: avgDeltaPct.toFixed(2),
              elasticity: elasticity.toFixed(4)
            }
          });
        } catch (e) {
          return json({ error: "Calculation error", details: e.message }, 500);
        }
      }

      // 3. GET /brokers (Mapping for frontend)
      if (url.pathname === "/brokers" && req.method === "GET") {
        try {
          const { results } = await env.SSSAHAM_DB.prepare("SELECT * FROM brokers").all();
          return json({ brokers: results || [] }); // Return array or object? User snippet expects { brokers: map } or array?
          // User snippet: "if (d.brokers) brokersMap = d.brokers;" 
          // But normally brokers table is list.
          // However, calculateRangeData in line 46 does: results.forEach(b => brokersMap[b.code] = b);
          // So let's return a map or list.
          // Let's return the list, and let frontend map it, OR map it here.
          // User snippet logic: `fetch... .then(d => { if (d.brokers) brokersMap = d.brokers; })`
          // If d.brokers is expected to be a map { 'YP': {...} }, I should convert it.
          // BUT standard D1 .all() returns array.
          // Let's look at the user snippet usage: `const broker = brokersMap[code];` -> Implies Object/Map.
          // So I should convert array to object here to match user's old API expectation, OR change frontend to map it.
          // Changing frontend is safer as I control it.
          // I will return the list as `brokers` array, and update frontend to reduce it to map.
        } catch (e) {
          return json({ error: "Failed to fetch brokers", details: e.message }, 500);
        }
      }

      // 4. GET /cache-summary (Renamed from /chart-data)
      if (url.pathname === "/cache-summary" && req.method === "GET") {
        const symbol = url.searchParams.get("symbol");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");

        let cacheMode = url.searchParams.get("cache") || "default";
        if (url.searchParams.get("reload") === "true") cacheMode = "rebuild";

        if (!symbol || !from || !to) return json({ error: "Missing params (symbol, from, to)" }, 400);

        const key = `broker/summary/v4/${symbol}/${from}_${to}.json`;

        // 1. READ CACHE (Only if mode is default)
        if (cacheMode === "default") {
          const cached = await env.SSSAHAM_EMITEN.get(key);
          if (cached) {
            const cachedData = await cached.json();
            // Validate Structure (Check if "foreign" summary exists)
            if (cachedData.summary && cachedData.summary.foreign) {
              return withCORS(new Response(JSON.stringify(cachedData), {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                  "X-Cache": "HIT"
                }
              }));
            }
            // If missing, fallthrough to re-calculate (MISS/STALE)
          }
        }

        // Calculate
        const data = await calculateRangeData(env, symbol, from, to);

        /**
 * @worker api-saham
 * @objective Provides public API endpoints for stock screener features, z-score history, broker lists, and aggregated broker summary (foreign/retail/local).
 *
 * @endpoints
 * - GET /screener -> Returns latest Z-Score screener data (via R2 pointer) (public)
 * - GET /features/history?symbol=... -> Returns historical Z-Score data for a ticker (public)
 * - GET /brokers -> Returns list of brokers from D1 (public)
 * - GET /cache-summary?symbol=...&from=...&to=... -> Returns aggregated broker summary (cached in R2) (public)
 * - GET /health -> Health check (public)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: none
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: R2 (SSSAHAM_EMITEN, RAW_BROKSUM), D1 (SSSAHAM_DB)
 * - writes: R2 (cache-summary results)
 *
 * @relations
 * - upstream: Data pipelines producing R2 features/broksum (unknown source)
 * - downstream: Frontend Clients
 *
 * @success_metrics
 * - Latency of /cache-summary (cache hit vs miss)
 * - Availability of screener data
 *
 * @notes
 * - Uses R2 'pointer' mechanism to find latest screener file.
 * - Implements 48h caching for broker summary.
 */
        // workers/api-saham/src/index.js
        // 3. WRITE CACHE (If not 'off')
        if (cacheMode !== "off") {
          const ttl = cacheMode === "rebuild" ? 604800 : 172800; // 7 days or 2 days

          await env.SSSAHAM_EMITEN.put(key, JSON.stringify(data), {
            httpMetadata: {
              contentType: "application/json",
              cacheControl: `public, max-age=${ttl}`
            },
            customMetadata: {
              generated_at: new Date().toISOString(),
              mode: cacheMode,
              ttl: ttl.toString()
            }
          });
        }

        return withCORS(new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "X-Cache-Mode": cacheMode
          }
        }));
      }

      // 5. GET /audit-trail (Proxy to R2)
      if (url.pathname === "/audit-trail" && req.method === "GET") {
        const symbol = url.searchParams.get("symbol");
        const limit = parseInt(url.searchParams.get("limit") || "100");
        if (!symbol) return json({ error: "Missing symbol" }, 400);

        try {
          const key = `audit/${symbol}.json`;
          const obj = await env.SSSAHAM_EMITEN.get(key);
          if (!obj) return json({ ok: true, symbol, entries: [], count: 0 });

          const data = await obj.json();
          let entries = data.entries || [];
          // Slice limit & Reverse (newest first)
          entries = entries.slice(-limit).reverse();

          return json({ ok: true, symbol, entries, count: entries.length });
        } catch (e) {
          return json({ error: "Fetch error", details: e.message }, 500);
        }
      }

      // 6. GET /logo (Proxy Image)
      if (url.pathname === "/logo") {
        const ticker = url.searchParams.get("ticker") || url.searchParams.get("symbol");
        if (!ticker) return json({ error: "Missing ticker or symbol" }, 400);

        // Helper to return Default Logo (IHSG)
        const returnDefault = async () => {
          const defaultKey = "logo/default.jpg";
          const defaultObj = await env.SSSAHAM_EMITEN.get(defaultKey);
          if (defaultObj) {
            const headers = new Headers();
            defaultObj.writeHttpMetadata(headers);
            headers.set('etag', defaultObj.httpEtag);
            headers.set('Cache-Control', 'public, max-age=2592000, immutable'); // Cache 30 days
            headers.set('Access-Control-Allow-Origin', '*');
            return new Response(defaultObj.body, { headers });
          }
          // Final fallback: transparent 1x1
          const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), c => c.charCodeAt(0));
          return new Response(png, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=3600",
              "Access-Control-Allow-Origin": "*"
            }
          });
        };

        const key = `logo/${ticker}.png`;
        let object = await env.SSSAHAM_EMITEN.get(key);

        if (!object) {
          // Read-Through Cache: Fetch from Upstream
          try {
            const upstreamUrl = `https://assets.stockbit.com/logos/companies/${ticker}.png`;
            // console.log(`[LOGO] Fetching upstream: ${upstreamUrl}`);
            const upstreamResp = await fetch(upstreamUrl);

            if (upstreamResp.ok) {
              const blob = await upstreamResp.blob();
              // Save to R2
              await env.SSSAHAM_EMITEN.put(key, blob.stream(), {
                httpMetadata: { contentType: "image/png" }
              });
              // Re-read or construct response
              object = await env.SSSAHAM_EMITEN.get(key);
            } else {
              // Upstream 404 -> Return Default
              return await returnDefault();
            }
          } catch (e) {
            // Fetch Error -> Return Default
            return await returnDefault();
          }
        }

        if (!object) return await returnDefault();

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=2592000, immutable'); // Cache 30 days
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, {
          headers
        });
      }

      // 6.5 DEBUG: Raw File Inspection
      if (url.pathname === "/debug/raw-file") {
        const key = url.searchParams.get("key");
        if (!key) return json({ error: "Missing key" }, 400);

        try {
          const obj = await env.RAW_BROKSUM.get(key);
          if (!obj) return json({ error: "Object not found", key }, 404);
          return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return json({ error: "Fetch error", details: e.message }, 500);
        }
      }

      // 7. Docs/Health
      if (url.pathname === "/health") return json({ ok: true, service: "api-saham" });

      // PROXY: Integrity Scan (to features-service via Service Binding)
      if (url.pathname === "/integrity-scan") {
        return env.FEATURES_SERVICE.fetch(req);
      }

      // Fallback
      return json({ error: "Not Found", method: req.method, path: url.pathname }, 404);

    } catch (err) {
      return json({ error: "Worker Error", details: err.stack || String(err) }, 500);
    }
  }
};

