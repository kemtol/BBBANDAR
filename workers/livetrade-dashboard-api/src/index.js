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
// WORKER STATUS & INTEGRITY CHECK
// ==============================
async function getWorkerStatus(env) {
  const result = {
    worker: {
      name: "livetrade-taping",
      status: "UNKNOWN",
      details: null,
      latency_ms: -1
    },
    data_integrity: {
      status: "UNKNOWN",
      last_file: null,
      last_file_age_ms: -1,
      bucket: "tape-data-saham",
      path_checked: ""
    },
    ts: Date.now()
  };

  // 1. Cek Worker Status via Service Binding
  if (env.TAPING) {
    const start = Date.now();
    try {
      // Panggil endpoint root / dari livetrade-taping
      const res = await env.TAPING.fetch("https://internal/");
      const latency = Date.now() - start;

      if (res.ok) {
        const data = await res.json();
        result.worker.status = "ONLINE"; // Worker responds
        result.worker.details = data;
        result.worker.latency_ms = latency;

        // Cek status internal worker
        // data.status biasanya "CONNECTED (LT + OB watchlist)" atau "Mati"
        if (data.status && data.status.startsWith("CONNECTED")) {
          result.worker.status = "HEALTHY";
        } else {
          result.worker.status = "WARNING"; // Responding but not connected
        }

      } else {
        result.worker.status = "ERROR";
        result.worker.details = `HTTP ${res.status}`;
      }
    } catch (err) {
      result.worker.status = "UNREACHABLE";
      result.worker.details = String(err);
    }
  } else {
    result.worker.details = "Binding TAPING missing";
  }

  // 2. Cek Data Integrity (R2)
  if (env.DATA_LAKE) {
    const now = new Date();
    // Cek path jam ini: raw_lt/YYYY/MM/DD/HH
    // Format: raw_lt/2025/08/08/10
    const pad = (n) => String(n).padStart(2, '0');
    const pathPrefix = `raw_lt/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${pad(now.getHours())}/`;

    result.data_integrity.path_checked = pathPrefix;

    try {
      // List 1 file terakhir (lexicographically last usually implies latest timestamp if named by timestamp)
      // Tapi R2 list order by default is key name.
      // Kalau nama file = timestamp.json, maka lexicographical ~ chronological.
      // Kita perlu daftar file, sort descending, ambil 1.
      // Optimasi: List tidak support sort reverse native di standard S3 xml, tapi R2 list return keys sorted.
      // Jadi kita ambil success, tapi mungkin kita butuh logic cursor kalau file banyak?
      // Untuk cek "live", kita harap ada file baru-baru ini.
      // Kita coba list tanpa limit ketat atau limit cukup besar lalu ambil yg terakhir? 
      // Atau list limit 100, lalu ambil max. 
      // Karena ini endpoint monitoring, kita tidak mau scan ribuan file.
      // ASUMSI: File baru akan selalu di bagian bawah list (urutan nama file membesar). 
      // Sayangnya list R2 mungkin pagination. 
      // Workaround: Cek menit ini atau menit sebelumnya? Itu ribet.
      // Kita list saja prefix jam ini. Kalau kosong, cek jam sebelumnya (jika menit < 5).

      let objects = await env.DATA_LAKE.list({ prefix: pathPrefix });

      // Jika jam baru mulai (misal menit 00:01), mungkin folder jam ini masih kosong.
      // Cek jam sebelumnya jika kosong
      if (objects.objects.length === 0 && now.getMinutes() < 5) {
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const prevPath = `raw_lt/${oneHourAgo.getFullYear()}/${pad(oneHourAgo.getMonth() + 1)}/${pad(oneHourAgo.getDate())}/${pad(oneHourAgo.getHours())}/`;
        result.data_integrity.path_checked += ` OR ${prevPath}`;
        const objPrev = await env.DATA_LAKE.list({ prefix: prevPath });
        // Combine logic simple
        if (objPrev.objects.length > 0) objects = objPrev;
      }

      if (objects.objects.length > 0) {
        // Ambil yang terakhir di list (asumsi sorted by key ascending)
        const lastObj = objects.objects[objects.objects.length - 1];
        result.data_integrity.last_file = lastObj.key;

        // Coba parse timestamp dari nama file jika format: .../1723456789000.json
        // Filename: .../timestamp.json
        const parts = lastObj.key.split('/');
        const fname = parts[parts.length - 1];
        const tsString = fname.replace('.json', '');
        const ts = Number(tsString);

        if (!isNaN(ts)) {
          result.data_integrity.last_file_age_ms = Date.now() - ts;
          // Status OK jika < 2 menit (120000ms) - asumsi data masuk setidaknya tiap menit
          if (result.data_integrity.last_file_age_ms < 120000) {
            result.data_integrity.status = "OK";
          } else if (result.data_integrity.last_file_age_ms < 300000) {
            result.data_integrity.status = "LAGGING"; // 2-5 mins delay
          } else {
            result.data_integrity.status = "STALE"; // > 5 mins
          }
        } else {
          // Fallback pakai uploaded property jika ada (tapi R2 list obj punya uploaded date)
          const uploaded = lastObj.uploaded;
          const age = Date.now() - new Date(uploaded).getTime();
          result.data_integrity.last_file_age_ms = age;
          result.data_integrity.status = age < 120000 ? "OK" : "STALE";
        }
      } else {
        result.data_integrity.status = "EMPTY"; // No data in current hour
      }

    } catch (err) {
      result.data_integrity.status = "ERROR";
      result.data_integrity.error = String(err);
    }
  }

  return withCORS(
    new Response(
      JSON.stringify(result, null, 2),
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

      // Monitoring Status Worker
      if (pathname === "/worker-status") {
        return getWorkerStatus(env);
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
