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
// CONSTANTS utk microstructure
// ==============================
const ROSTER_KEY = "ROSTER_ACTIVE";
const DEFAULT_SYMBOLS = [
  "BBCA", "BBRI", "BMRI", "BRIS", "ADRO",
  "TLKM", "BBNI", "ARTO", "BUMI", "BMTR",
];

function clamp01(x) {
  if (Number.isNaN(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ==============================
// DASHBOARD API – microstructure
// ==============================
async function loadRoster(env) {
  const raw = await env.ROSTER_KV.get(ROSTER_KEY);
  if (!raw) return DEFAULT_SYMBOLS;

  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch (err) {
    console.error("Invalid roster JSON", err);
  }
  return DEFAULT_SYMBOLS;
}

async function loadSymbolState(env, symbol) {
  const key = `state:${symbol}`;
  const raw = await env.STATE_KV.get(key);
  if (!raw) {
    return {
      symbol,
      money: 0.5,
      momentum: 0.5,
      zone: "UL",
      updatedAt: null,
    };
  }

  try {
    const s = JSON.parse(raw);
    return {
      symbol: s.symbol || symbol,
      money: clamp01(s.money ?? 0.5),
      momentum: clamp01(s.momentum ?? 0.5),
      zone: s.zone || "UL",
      updatedAt: s.updatedAt || null,
    };
  } catch (err) {
    console.error("Invalid state JSON", symbol, err);
    return {
      symbol,
      money: 0.5,
      momentum: 0.5,
      zone: "UL",
      updatedAt: null,
    };
  }
}

async function handlePredictions(env) {
  const roster = await loadRoster(env);
  const data = [];

  for (const symbol of roster) {
    const state = await loadSymbolState(env, symbol);
    data.push(state);
  }

  return withCORS(
    new Response(JSON.stringify({ data }, null, 2), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

// ==============================
// SWING SCANNER API lama
// ==============================

// GET /summary
async function getSummary(env, url) {
  const mode = url.searchParams.get("mode") || "swing";

  const obj = await env.DATA_LAKE.get("snapshot_latest.json");
  if (!obj) {
    return withCORS(
      new Response("snapshot_latest not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }

  const text = await obj.text();
  const rows = JSON.parse(text); // array of { kode, close, high, ... }

  // Contoh: ambil top 50 by val
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

// GET /symbol
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
      new Response("snapshot_latest not found", {
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

  // Durable Object state-engine (opsional)
  let stateInfo = null;
  try {
    if (env.STATE_ENGINE) {
      const id = env.STATE_ENGINE.idFromName("GLOBAL_STATE");
      const stub = env.STATE_ENGINE.get(id);

      const res = await stub.fetch("https://dummy/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kode, mode, snapshot_row: row }),
      });

      if (res.ok) {
        stateInfo = await res.json();
      } else {
        stateInfo = { error: `state_engine_http_${res.status}` };
      }
    } else {
      stateInfo = { note: "STATE_ENGINE not bound yet" };
    }
  } catch (e) {
    stateInfo = { error: "state_engine_unreachable" };
  }

  return withCORS(
    new Response(
      JSON.stringify(
        {
          kode,
          mode,
          snapshot: row,
          state: stateInfo,
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

    // Health check (pindahin ke /health biar root bisa bebas)
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

    // Root boleh kasih info singkat
    if (pathname === "/") {
      return withCORS(
        new Response(
          JSON.stringify(
            {
              message:
                "Bandar Radar API. Gunakan /summary, /symbol, atau /api/predictions.",
            },
            null,
            2
          ),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }

    // Swing summary
    if (pathname === "/summary") {
      return getSummary(env, url);
    }

    // Detail per saham (swing)
    if (pathname === "/symbol") {
      return getSymbolDetail(env, url);
    }

    // Microstructure predictions untuk scalp radar
    if (pathname === "/api/predictions") {
      return handlePredictions(env);
    }

    return withCORS(new Response("Not found", { status: 404 }));
  },
};
