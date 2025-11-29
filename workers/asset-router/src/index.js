//==============================================
// workers/asset-router/src/index.js
//==============================================
/*.
├── auth-uid
│   ├── migrations
│   ├── node_modules
│   ├── package.json
│   ├── package-lock.json
│   ├── README.md
│   ├── src
│   └── wrangler.toml
├── asset-analyzer
│   ├── node_modules
│   ├── src
│   └── wrangler.toml
├── asset-preprocess
│   ├── node_modules
│   ├── src
│   └── wrangler.toml
├── asset-router
│   ├── node_modules
│   ├── src
│   └── wrangler.toml
├── README-DEV.md
├── reko-worker
│   ├── node_modules
│   ├── src
│   └── wrangler.toml
└── workers-structure.txt
*/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname || "/";
    const method = request.method || "GET";

    // --- CORS preflight ---
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      // 1) HEALTH CHECK
      if (method === "GET" && path === "/health") {
        return json({ ok: true, worker: "asset-router", status: "healthy" });
      }

      // 2) MAIN ROUTE: terima JSON payload dari wizard, teruskan ke asset-preprocess
      else if (method === "POST" && path === "/pass-imgs") {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json(
            {
              ok: false,
              error: "Use application/json dan kirim payload wizard sebagai JSON.",
            },
            400
          );
        }

        if (!env.PREPROCESS_URL) {
          return json(
            { ok: false, error: "Missing PREPROCESS_URL in environment" },
            500
          );
        }

        const rawPayload = await request.json();

        // ⬇️ ini akan muncul di terminal wrangler dev asset-router
        console.log("[asset-router] incoming payload:", JSON.stringify(rawPayload, null, 2));

        // Teruskan ke asset-preprocess (JSON → endpoint "/")
        const preResp = await fetch(env.PREPROCESS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rawPayload),
        });

        const preText = await preResp.text();
        console.log("[asset-router] preprocess response:", preResp.status, preText);

        return new Response(preText, {
          status: preResp.status,
          headers: {
            "Content-Type": preResp.headers.get("Content-Type") || "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // 3) FALLBACK
      else {
        return json(
          {
            ok: false,
            error:
              "Unknown route. Gunakan GET /health atau POST /pass-imgs untuk wizard.",
          },
          404
        );
      }
    } catch (err) {
      console.error("[asset-router] error:", err);
      return json({ ok: false, error: err.message || String(err) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
