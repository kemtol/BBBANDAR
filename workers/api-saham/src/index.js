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

  return {
    history: results,
    summary: {
      top_buyers: format('bval'),
      top_sellers: format('sval'),
      top_net_buyers: allNet.filter(b => b.net > 0).sort((a, b) => b.net - a.net).slice(0, 20),
      top_net_sellers: allNet.filter(b => b.net < 0).sort((a, b) => a.net - b.net).slice(0, 20)
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

      // CORS
      if (req.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));

      // 1. GET /screener
      if (url.pathname === "/screener" && req.method === "GET") {
        try {
          const obj = await env.SSSAHAM_EMITEN.get("features/latest.json");
          if (!obj) return json({ items: [] });
          return withCORS(new Response(obj.body, { headers: { "Content-Type": "application/json" } }));
        } catch (e) {
          return json({ error: "Failed to fetch screener", details: e.message }, 500);
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

      // 3. GET /cache-summary (Renamed from /chart-data)
      if (url.pathname === "/cache-summary" && req.method === "GET") {
        const symbol = url.searchParams.get("symbol");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const reload = url.searchParams.get("reload") === "true";

        if (!symbol || !from || !to) return json({ error: "Missing params (symbol, from, to)" }, 400);

        const key = `broker/summary/${symbol}/${from}_${to}.json`;
        const ttl = 172800; // 48 hours

        // Try Cache
        if (!reload) {
          const cached = await env.SSSAHAM_EMITEN.get(key);
          if (cached) {
            return new Response(cached.body, {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "X-Cache": "HIT"
              }
            });
          }
        }

        // Calculate
        const data = await calculateRangeData(env, symbol, from, to);

        // Save Cache
        await env.SSSAHAM_EMITEN.put(key, JSON.stringify(data), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { generated_at: new Date().toISOString() }
          // R2 doesn't support expirationTtl in put() directly via binding unless using specific methods or lifecycle rules.
          // Workers R2 binding put() does NOT support 'expirationTtl' option like KV.
          // We must rely on Bucket Lifecycle Rules or manual cleanup.
          // User asked for cache. We will just save it.
        });

        return json(data, 200, { "X-Cache": reload ? "RELOAD" : "MISS" });
      }

      // 4. Docs/Health
      if (url.pathname === "/health") return json({ ok: true, service: "api-saham" });

      // Fallback
      return withCORS(new Response("Not Found", { status: 404 }));

    } catch (err) {
      return withCORS(
        new Response("Worker error: " + (err?.stack || String(err)), { status: 500 })
      );
    }
  }
};
