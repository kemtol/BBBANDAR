// workers/api-saham/src/index.js
import openapi from "./openapi.json";

const PUBLIC_PATHS = new Set(["/", "/docs", "/console", "/openapi.json", "/health"]);

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
// Docs HTML (Redoc 2-column)
// ==============================
function redocHTML() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SSSAHAM API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>body{margin:0}</style>
</head>
<body>
  <redoc
    spec-url="/openapi.json"
    theme='{
      "rightPanel": {
        "backgroundColor": "#124e8aff"
      }
    }'>
  </redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`;
}

// ==============================
// Console HTML (no swagger)
// ==============================
function consoleHTML() {
  // Endpoint list (sesuaikan kalau kamu tambah routes)
  const endpoints = [
    { id: "health", label: "GET /health (public)", method: "GET", path: "/health", auth: false },
    { id: "me", label: "GET /me", method: "GET", path: "/me", auth: true },
    { id: "roster", label: "GET /market/roster", method: "GET", path: "/market/roster", auth: true },
    { id: "summary", label: "GET /summary?mode=intraday|swing", method: "GET", path: "/summary", auth: true, hasMode: true },
    { id: "signal", label: "GET /signal/{kode}?mode=intraday|swing", method: "GET", path: "/signal/{kode}", auth: true, hasKode: true, hasMode: true }
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SSSAHAM API Console</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b1020; color:#e7eaf3; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 20px; }
    .card { background:#121a33; border:1px solid #22305b; border-radius:14px; padding:16px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .col { flex: 1 1 240px; }
    label { display:block; font-size:12px; opacity:.85; margin: 8px 0 6px; }
    input, select, textarea {
      width:100%; box-sizing:border-box;
      background:#0e1530; color:#e7eaf3;
      border:1px solid #22305b; border-radius:10px;
      padding:10px 12px; outline:none;
    }
    textarea { min-height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    button {
      background:#2a3cff; color:white; border:0; border-radius:10px;
      padding:10px 14px; cursor:pointer; font-weight:600;
    }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .meta { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:12px; font-size:12px; opacity:.9; }
    .badge { border:1px solid #22305b; padding:6px 10px; border-radius:999px; background:#0e1530; }
    .top { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:12px; }
    a { color:#9fb2ff; text-decoration:none; }
    .hint { font-size:12px; opacity:.75; margin-top:6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div style="font-size:18px;font-weight:800;">SSSAHAM API Console</div>
        <div class="hint">No Swagger. Test endpoint langsung dari browser. (Works with Redoc docs)</div>
      </div>
      <div class="row" style="align-items:center;">
        <a href="/docs">Docs</a>
        <a href="/openapi.json">OpenAPI</a>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <div class="col">
          <label>Server</label>
          <select id="server">
            <option value="">(Current origin)</option>
            <option value="https://api-saham.mkemalw.workers.dev">Dev</option>
            <option value="https://api.sssaham.com">Production</option>
          </select>
          <div class="hint">Default: pakai domain yang sedang kamu buka.</div>
        </div>

        <div class="col">
          <label>API Key (X-API-KEY)</label>
          <input id="apikey" placeholder="tempel API key di sini (untuk endpoint protected)" />
          <div class="hint">Endpoint public seperti /health tidak butuh key.</div>
        </div>
      </div>

      <div class="row">
        <div class="col">
          <label>Endpoint</label>
          <select id="endpoint"></select>
        </div>

        <div class="col" id="kodeWrap" style="display:none;">
          <label>Kode (untuk /signal/{kode})</label>
          <input id="kode" placeholder="contoh: ADRO" />
        </div>

        <div class="col" id="modeWrap" style="display:none;">
          <label>Mode</label>
          <select id="mode">
            <option value="intraday">intraday</option>
            <option value="swing">swing</option>
          </select>
        </div>
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="col">
          <button id="run">Execute</button>
          <button id="clear" style="margin-left:8px;background:#202a4a;">Clear</button>
          <div class="meta">
            <div class="badge" id="reqUrl">URL: -</div>
            <div class="badge" id="status">Status: -</div>
            <div class="badge" id="latency">Latency: -</div>
          </div>
        </div>
      </div>
    </div>

    <div style="height:14px;"></div>

    <div class="card">
      <label>Response</label>
      <textarea id="out" spellcheck="false" placeholder="Klik Execute untuk melihat response..."></textarea>
    </div>
  </div>

<script>
  const endpoints = ${JSON.stringify(endpoints)};

  const $server = document.getElementById("server");
  const $apikey = document.getElementById("apikey");
  const $endpoint = document.getElementById("endpoint");
  const $kodeWrap = document.getElementById("kodeWrap");
  const $modeWrap = document.getElementById("modeWrap");
  const $kode = document.getElementById("kode");
  const $mode = document.getElementById("mode");
  const $run = document.getElementById("run");
  const $clear = document.getElementById("clear");
  const $out = document.getElementById("out");
  const $reqUrl = document.getElementById("reqUrl");
  const $status = document.getElementById("status");
  const $latency = document.getElementById("latency");

  // populate endpoints
  endpoints.forEach(e => {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.label;
    $endpoint.appendChild(opt);
  });

  function selected() {
    const id = $endpoint.value;
    return endpoints.find(e => e.id === id);
  }

  function buildUrl() {
    const base = $server.value || location.origin;
    const e = selected();

    let path = e.path;

    if (e.hasKode) {
      const k = ($kode.value || "").trim().toUpperCase();
      path = path.replace("{kode}", encodeURIComponent(k || "ADRO"));
    }

    const u = new URL(base + path);

    if (e.hasMode) {
      u.searchParams.set("mode", $mode.value || "intraday");
    }

    return u.toString();
  }

  function refreshUI() {
    const e = selected();
    $kodeWrap.style.display = e.hasKode ? "" : "none";
    $modeWrap.style.display = e.hasMode ? "" : "none";
    $reqUrl.textContent = "URL: " + buildUrl();
  }

  $endpoint.addEventListener("change", refreshUI);
  $kode.addEventListener("input", refreshUI);
  $mode.addEventListener("change", refreshUI);
  $server.addEventListener("change", refreshUI);

  $clear.addEventListener("click", () => {
    $out.value = "";
    $status.textContent = "Status: -";
    $latency.textContent = "Latency: -";
  });

  $run.addEventListener("click", async () => {
    const e = selected();
    const url = buildUrl();

    $run.disabled = true;
    $status.textContent = "Status: ...";
    $latency.textContent = "Latency: ...";
    $reqUrl.textContent = "URL: " + url;

    const headers = {};
    if (e.auth) {
      const key = ($apikey.value || "").trim();
      if (key) headers["X-API-KEY"] = key;
    }

    const t0 = performance.now();
    try {
      const resp = await fetch(url, { method: e.method, headers });
      const t1 = performance.now();

      $status.textContent = "Status: " + resp.status + " " + resp.statusText;
      $latency.textContent = "Latency: " + Math.round(t1 - t0) + " ms";

      const text = await resp.text();
      // pretty print if json
      try {
        const obj = JSON.parse(text);
        $out.value = JSON.stringify(obj, null, 2);
      } catch {
        $out.value = text;
      }
    } catch (err) {
      const t1 = performance.now();
      $status.textContent = "Status: FETCH ERROR";
      $latency.textContent = "Latency: " + Math.round(t1 - t0) + " ms";
      $out.value = String(err && (err.stack || err.message) || err);
    } finally {
      $run.disabled = false;
    }
  });

  refreshUI();
</script>
</body>
</html>`;
}

// ==============================
// Auth helpers
// ==============================
function unauthorized() {
  return json({ error: "Unauthorized", message: "Missing/invalid X-API-KEY" }, 401);
}

function isAuthorized(req, env) {
  const expected = env?.API_KEY;
  if (!expected) return false;
  const got = req.headers.get("X-API-KEY");
  return !!got && got === expected;
}

// ==============================
// Worker
// ==============================
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      // ===== CORS preflight =====
      if (req.method === "OPTIONS") {
        return withCORS(new Response(null, { status: 204 }));
      }

      // ===== Public: Docs =====
      if (url.pathname === "/" || url.pathname === "/docs") {
        return withCORS(
          new Response(redocHTML(), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          })
        );
      }

      // ===== Public: Console =====
      if (url.pathname === "/console") {
        return withCORS(
          new Response(consoleHTML(), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          })
        );
      }

      // ===== Public: OpenAPI Spec =====
      if (url.pathname === "/openapi.json") {
        return json(openapi, 200);
      }

      // ===== Public: Health =====
      if (url.pathname === "/health" && req.method === "GET") {
        return json({ ok: true, service: "api-saham", ts: new Date().toISOString() });
      }

      // ===== Auth guard (for everything else) =====
      if (!PUBLIC_PATHS.has(url.pathname)) {
        if (!isAuthorized(req, env)) return unauthorized();
      }

      // ===== Protected: /me =====
      if (url.pathname === "/me" && req.method === "GET") {
        return json({ authorized: true, plan: "dev" });
      }

      // ===== Protected: /market/roster =====
      if (url.pathname === "/market/roster" && req.method === "GET") {
        const items = ["BBCA", "BBRI", "BMRI", "ADRO", "TLKM"];
        return json({ count: items.length, items });
      }

      // ===== Protected: /summary =====
      if (url.pathname === "/summary" && req.method === "GET") {
        const mode = url.searchParams.get("mode") || "intraday";
        return json({
          mode,
          count: 2,
          items: [
            { kode: "ADRO", signal_side: "SELL", last: 1840 },
            { kode: "BBCA", signal_side: "BUY", last: 9450 }
          ]
        });
      }

      // ===== Protected: /signal/{kode} =====
      if (url.pathname.startsWith("/signal/") && req.method === "GET") {
        const kode = (url.pathname.split("/")[2] || "").toUpperCase();
        const mode = url.searchParams.get("mode") || "intraday";

        return json({
          kode: kode || "UNKNOWN",
          mode,
          signal_side: "NONE",
          confidence: 0.5,
          last: 0
        });
      }

      return withCORS(new Response("Not Found", { status: 404 }));
    } catch (err) {
      return withCORS(
        new Response("Worker error: " + (err?.stack || err?.message || String(err)), {
          status: 500
        })
      );
    }
  }
};
