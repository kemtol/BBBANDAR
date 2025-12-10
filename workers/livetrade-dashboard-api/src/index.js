// workers/livetrade-dashboard-api/src/index.js

// ==============================
// CORS helper
// ==============================
function withCORS(resp) {
  const headers = new Headers(resp.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");

  return new Response(resp.body, {
    status: resp.status || 200,
    headers,
  });
}

// ==============================
// ROSTER INTRADAY (TANPA KV)
// ==============================
const DEFAULT_SYMBOLS = [
  "BBCA", "BBRI", "BMRI", "BRIS", "ADRO",
  "TLKM", "BBNI", "ARTO", "BUMI", "BMTR",
];

// helper kecil kalau mau baca watchlist langsung dari env (opsional)
function buildWatchListFromEnv(env) {
  const parse = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

  const lq45 = parse(env.WATCHLIST_LQ45);
  const idx30 = parse(env.WATCHLIST_IDX30);
  const custom = parse(env.WATCHLIST_CUSTOM);

  const merged = [...new Set([...lq45, ...idx30, ...custom])];
  return merged;
}

async function loadRoster(env) {
  // 1) Coba ambil dari livetrade-taping → /watchlist
  if (env.TAPING) {
    try {
      const internalUrl = new URL("https://internal/watchlist");
      const res = await env.TAPING.fetch(internalUrl.toString());
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.symbols) && data.symbols.length > 0) {
          console.log("[ROSTER] from TAPING /watchlist:", data.symbols);
          return data.symbols;
        } else {
          console.log("[ROSTER] TAPING /watchlist kosong");
        }
      } else {
        console.warn("[ROSTER] gagal TAPING /watchlist:", res.status);
      }
    } catch (err) {
      console.error("[ROSTER] error TAPING /watchlist:", err);
    }
  }

  const mergedEnv = buildWatchListFromEnv(env);
  if (mergedEnv.length > 0) {
    console.log("[ROSTER] from dashboard env:", mergedEnv);
    return mergedEnv;
  }

  // jangan fallback
  console.error("[ROSTER] watchlist kosong (TAPING & env).");
  return [];

}

// Helper kecil: map dengan batas concurrency
async function mapWithConcurrency(list, limit, fn) {
  const results = new Array(list.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const current = idx++;
      if (current >= list.length) break;
      results[current] = await fn(list[current], current);
    }
  }

  const workers = [];
  const workerCount = Math.min(limit, list.length || 0);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

const MAX_SYMBOLS_INTRADAY = 30; // boleh kamu kecilin sementara, misal 20
const MAX_CONCURRENCY_INTRADAY = 5;
async function loadOpenPriceMap(env) {
  try {
    const obj = await env.DATA_LAKE.get("snapshot_latest.json");
    if (!obj) {
      console.warn("[INTRADAY] snapshot_latest.json not found, open map kosong.");
      return {};
    }

    const text = await obj.text();
    const rows = JSON.parse(text); // array hasil buildFinalOutputFromStats

    const map = {};
    for (const row of rows) {
      const kode = String(row.kode || "").toUpperCase();
      if (!kode) continue;

      // di snapshot, field open = openDay
      const open = Number(row.open || row.open_day || 0);
      if (!Number.isFinite(open) || open <= 0) continue;

      map[kode] = open;
    }

    console.log("[INTRADAY] open price map loaded, count =", Object.keys(map).length);
    return map;
  } catch (err) {
    console.error("[INTRADAY] gagal load open price map:", err);
    return {};
  }
}

// ==============================
// INTRADAY SUMMARY (via AGGREGATOR) – versi tahan banting
// ==============================
async function getIntradaySummary(env) {
  try {
    const rosterFull = await loadRoster(env);
    const openMap = await loadOpenPriceMap(env);
    if (!rosterFull || rosterFull.length === 0) {
      return withCORS(
        new Response(
          JSON.stringify(
            { mode: "intraday", count: 0, items: [], error: "Watchlist kosong" },
            null,
            2
          ),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }

    const roster = rosterFull.slice(0, MAX_SYMBOLS_INTRADAY);

    const diag = [];

    if (!env.AGGREGATOR) {
      return withCORS(
        new Response(
          JSON.stringify(
            {
              mode: "intraday",
              count: 0,
              items: [],
              error: "AGGREGATOR binding missing",
            },
            null,
            2
          ),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }

    const results = await mapWithConcurrency(
      roster,
      MAX_CONCURRENCY_INTRADAY,
      async (symbol) => {
        const kode = symbol.toUpperCase();
        const internalUrl = new URL("https://internal/signal-realtime");
        internalUrl.searchParams.set("kode", kode);
        internalUrl.searchParams.set("lite", "1");

        try {
          const res = await env.AGGREGATOR.fetch(internalUrl.toString());
          if (!res.ok) {
            diag.push({ kode, status: res.status });
            return null;
          }

          const data = await res.json();

          const hakaRatio =
            typeof data.haka_ratio === "number" ? data.haka_ratio : 0.5;
          const momentumScore =
            typeof data.momentum_score === "number" ? data.momentum_score : 0;
          const intentionScore =
            typeof data.intention_score === "number" ? data.intention_score : 0;
          const fusedSignal =
            typeof data.fused_signal === "number" ? data.fused_signal : 0;

          const sampleCounts = data.sample_counts || {};
          const tradeCount =
            typeof sampleCounts.trades === "number" ? sampleCounts.trades : 0;

          const lastPrice =
            data.last_trade && data.last_trade.price
              ? data.last_trade.price
              : 0;

          // ⬅️ kalau belum ada trade / harga valid, skip dari intraday scanner
          if (!tradeCount || !lastPrice) {
            diag.push({ kode, note: "no_recent_trades" });
            return null;
          }

          const hakaPct = Math.round(hakaRatio * 100);
          const fluktuasi = Number((momentumScore * 5).toFixed(2));
          const obImb = Number((intentionScore * 100).toFixed(1));
          const moneyFlow = fusedSignal;
          // --- HITUNG %DAY BERDASARKAN OPEN DAY DARI SNAPSHOT ---
          const openDay = Number(openMap[kode] || 0);
          let intradayReturnPct = 0;

          if (openDay > 0 && lastPrice > 0) {
            intradayReturnPct = ((lastPrice - openDay) / openDay) * 100;
          }

          // clamp kalau mau (optional)
          if (!Number.isFinite(intradayReturnPct)) intradayReturnPct = 0;

          return {
            kode,

            // 💡 info dasar
            last: lastPrice,
            vol: tradeCount,
            net_vol: Math.round(tradeCount * moneyFlow),

            // 💡 dimensi bias
            haka_pct: hakaPct,
            fluktuasi,
            momentum: fluktuasi,             // biar legacy tetap jalan
            money_flow: moneyFlow,
            ob_imbalance: obImb,
            fused_signal: fusedSignal,
            signal_side: data.side || "NONE",
            hidden_acc_score: 0,

            // 💡 field baru untuk UI
            open_day: openDay,
            intraday_return_pct: Number(intradayReturnPct.toFixed(2)),
          };

        } catch (err) {
          console.error("Error call /signal-realtime untuk", kode, err);
          diag.push({ kode, error: String(err) });
          return null;
        }
      }
    );

    const items = results.filter((x) => x !== null);

    return withCORS(
      new Response(
        JSON.stringify(
          {
            mode: "intraday",
            count: items.length,
            items,
            diag,
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      )
    );
  } catch (err) {
    console.error("getIntradaySummary crash:", err);
    return withCORS(
      new Response(
        JSON.stringify(
          {
            mode: "intraday",
            count: 0,
            items: [],
            error: String(err),
          },
          null,
          2
        ),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );
  }
}


// ==============================
// SWING SUMMARY (snapshot_latest.json di R2)
// ==============================
async function getSwingSummary(env, mode) {
  const obj = await env.DATA_LAKE.get("snapshot_latest.json");
  if (!obj) {
    return withCORS(
      new Response(
        JSON.stringify(
          {
            mode,
            count: 0,
            items: [],
            note: "snapshot_latest.json not found",
          },
          null,
          2
        ),
        {
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  }

  const text = await obj.text();
  const rows = JSON.parse(text); // array of { kode, close, high, ... }

  const sorted = [...rows].sort((a, b) => (b.val || 0) - (a.val || 0));
  const top = sorted.slice(0, 50);

  return withCORS(
    new Response(
      JSON.stringify(
        {
          mode,
          count: top.length,
          items: top,
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    )
  );
}

// ==============================
// SUMMARY ROUTE (wrapper)
// ==============================
async function getSummary(env, url) {
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam || "swing";

  if (mode === "intraday") {
    return getIntradaySummary(env);
  }

  return getSwingSummary(env, mode);
}

// ==============================
// SYMBOL DETAIL (pakai snapshot_latest.json)
// ==============================
async function getSymbolDetail(env, url) {
  const kode = url.searchParams.get("kode");
  const mode = url.searchParams.get("mode") || "swing";

  if (!kode) {
    return withCORS(
      new Response("Butuh ?kode=XXXX", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }

  const obj = await env.DATA_LAKE.get("snapshot_latest.json");
  if (!obj) {
    return withCORS(
      new Response("snapshot_latest.json not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }

  const text = await obj.text();
  const rows = JSON.parse(text);

  const row = rows.find((r) => r.kode === kode);
  if (!row) {
    return withCORS(
      new Response(`Kode ${kode} tidak ada di snapshot`, {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }

  return withCORS(
    new Response(
      JSON.stringify(
        {
          kode,
          mode,
          snapshot: row,
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    )
  );
}

// ==============================
// MAIN HANDLER
// ==============================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    try {
      // Health check
      if (pathname === "/health") {
        return withCORS(
          new Response(
            JSON.stringify(
              {
                service: "bandar-dashboard-api",
                status: "OK",
                project: env.PROJECT_NAME || "BBBandar",
                ts: Date.now(),
              },
              null,
              2
            ),
            { headers: { "Content-Type": "application/json" } }
          )
        );
      }

      // Root info
      if (pathname === "/") {
        return withCORS(
          new Response(
            JSON.stringify(
              {
                message:
                  "Bandar Radar API. Gunakan /summary, /symbol, /signal-realtime.",
              },
              null,
              2
            ),
            { headers: { "Content-Type": "application/json" } }
          )
        );
      }

      // Summary (swing / intraday)
      if (pathname === "/summary") {
        return getSummary(env, url);
      }

      // Detail snapshot per saham (swing)
      if (pathname === "/symbol") {
        return getSymbolDetail(env, url);
      }

      // Proxy realtime signal langsung ke agregator
      if (pathname === "/signal-realtime") {
        const kode = (url.searchParams.get("kode") || "GOTO").toUpperCase();
        const lite = url.searchParams.get("lite") === "1";

        if (!env.AGGREGATOR) {
          return withCORS(
            new Response(
              JSON.stringify(
                {
                  status: "ERROR",
                  message: "AGGREGATOR service binding belum dikonfigurasi",
                },
                null,
                2
              ),
              { status: 500, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        const internalUrl = new URL("https://internal/signal-realtime");
        internalUrl.searchParams.set("kode", kode);
        if (lite) internalUrl.searchParams.set("lite", "1");

        const res = await env.AGGREGATOR.fetch(internalUrl.toString());

        return withCORS(
          new Response(res.body, {
            status: res.status,
            headers: {
              "Content-Type":
                res.headers.get("Content-Type") || "application/json",
            },
          })
        );
      }


      return withCORS(new Response("Not found", { status: 404 }));
    } catch (err) {
      console.error("dashboard-api fetch error:", err);
      return withCORS(
        new Response(
          JSON.stringify(
            { status: "ERROR", message: String(err) },
            null,
            2
          ),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      );
    }
  },
};
