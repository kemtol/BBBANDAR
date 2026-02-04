import openapi from "./openapi.json";

const PUBLIC_PATHS = new Set(["/", "/docs", "/console", "/openapi.json", "/health", "/screener", "/cache-summary", "/features/history"]);

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

  return {
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
      console.log(`[API-SAHAM] Request: ${req.method} ${url.pathname} (v2026-02-04-A)`);

      // CORS
      if (req.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));

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

      // 1.5 GET /logo?symbol=XXXX - Serve logo from R2
      if ((url.pathname === "/logo" || url.pathname === "/logo/") && req.method === "GET") {
        console.log("LOG: /logo request received for", url.searchParams.get("symbol"));
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400);

        try {
          const key = `comp-profile/logo/${symbol.toUpperCase()}.png`;
          const obj = await env.SSSAHAM_EMITEN.get(key);

          if (!obj) {
            // Return 1x1 transparent PNG as fallback
            return new Response(null, { status: 404 });
          }

          return withCORS(new Response(obj.body, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=86400" // Cache for 24 hours
            }
          }));
        } catch (e) {
          return json({ error: "Failed to fetch logo", details: e.message }, 500);
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
        const reload = url.searchParams.get("reload") === "true";

        if (!symbol || !from || !to) return json({ error: "Missing params (symbol, from, to)" }, 400);

        const key = `broker/summary/v4/${symbol}/${from}_${to}.json`;
        const ttl = 172800; // 48 hours

        // Try Cache
        if (!reload) {
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
        // Save Cache
        await env.SSSAHAM_EMITEN.put(key, JSON.stringify(data), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { generated_at: new Date().toISOString() }
          // R2 doesn't support expirationTtl in put() directly via binding unless using specific methods or lifecycle rules.
          // We must rely on Bucket Lifecycle Rules or manual cleanup.
          // User asked for cache. We will just save it.
        });

        return json(data, 200, { "X-Cache": reload ? "RELOAD" : "MISS" });
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

      // 6. Docs/Health
      if (url.pathname === "/health") return json({ ok: true, service: "api-saham" });

      // Fallback
      return withCORS(new Response(`Not Found. You requested: ${req.method} ${url.pathname}`, { status: 404 }));

    } catch (err) {
      return withCORS(
        new Response("Worker error: " + (err?.stack || String(err)), { status: 500 })
      );
    }
  }
};
