// workers/asset-router/src/index.js

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

      // 2) SANITY PROD (buat test cepat dari curl)
      if (method === "POST" && path === "/sanity") {
        const body = await safeJson(request);
        return json({
          ok: true,
          worker: "asset-router",
          mode: "sanity",
          echo: body,
        });
      }

      // 3) MAIN ROUTE: terima JSON payload dari wizard, teruskan ke asset-preprocess
      if (method === "POST" && path === "/pass-imgs") {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json(
            {
              ok: false,
              error:
                "Use application/json dan kirim payload wizard sebagai JSON.",
            },
            400
          );
        }

        const rawPayload = await safeJson(request);
        const traceId = rawPayload.trace_id || "no-trace";

        console.log(
          "[asset-router] incoming payload:",
          JSON.stringify(
            {
              wizard_version: rawPayload.wizard_version,
              pair: rawPayload.pair,
              style: rawPayload.style,
              analysis_mode: rawPayload.analysis_mode,
              screenshot_counts: rawPayload.screenshot_counts,
            },
            null,
            2
          )
        );

        let preResp;

        if (env.PREPROCESS_SVC) {
          preResp = await env.PREPROCESS_SVC.fetch("http://internal/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rawPayload),
          });
        } else {
          const target = (env.PREPROCESS_URL || "").trim();
          if (!target) {
            return json(
              {
                ok: false,
                error:
                  "No PREPROCESS_SVC binding and PREPROCESS_URL is not set in environment.",
              },
              500
            );
          }

          const base = target.endsWith("/") ? target : target + "/";
          preResp = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rawPayload),
          });
        }

        const preText = await preResp.text();
        console.log("[asset-router] ← preprocess", traceId, preResp.status, preText.slice(0, 500));

        return new Response(preText, {
          status: preResp.status,
          headers: {
            "Content-Type":
              preResp.headers.get("Content-Type") || "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // 3B) NEW: /asset-analyzer → forward ke multi-agent (→ asset-analyzer)
      if (method === "POST" && path === "/asset-analyzer") {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json(
            {
              ok: false,
              error: "Use application/json untuk /asset-analyzer.",
            },
            400
          );
        }

        const rawPayload = await safeJson(request);
        const traceId = rawPayload.trace_id || "no-trace";

        console.log("[asset-router] → /asset-analyzer", traceId, {
          analysis_mode: rawPayload.analysis_mode,
          asset_type: rawPayload.asset_type,
          asset_symbol: rawPayload.asset_symbol,
          charts_len: rawPayload.charts?.length ?? 0
        });

        let analyzerResp;

        if (env.MULTI_AGENT_SVC) {
          // service binding (opsional)
          analyzerResp = await env.MULTI_AGENT_SVC.fetch(
            "http://internal/multi-agent",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(rawPayload),
            }
          );
        } else {
          const target = (env.MULTI_AGENT_URL || "").trim() ||
            "http://127.0.0.1:8790/multi-agent";

          analyzerResp = await fetch(target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rawPayload),
          });
        }

        const text = await analyzerResp.text();
        console.log("[asset-router] ← analyzer", traceId, analyzerResp.status, text.slice(0, 500));

        return new Response(text, {
          status: analyzerResp.status,
          headers: {
            "Content-Type":
              analyzerResp.headers.get("Content-Type") || "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }


      // 4) FALLBACK
      return json(
        {
          ok: false,
          error:
            "Unknown route. Gunakan GET /health, POST /sanity, atau POST /pass-imgs untuk wizard.",
        },
        404
      );
    } catch (err) {
      console.error("[asset-router] error:", err);
      return json(
        { ok: false, error: err.message || String(err) },
        500
      );
    }
  },
};

// ===== Helpers =====

async function safeJson(request) {
  try {
    return await request.json();
  } catch (e) {
    throw new Error("Body bukan JSON valid: " + (e.message || String(e)));
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
