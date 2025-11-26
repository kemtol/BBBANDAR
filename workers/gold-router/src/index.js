// workers/gold-router/src/index.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname || "/";
    const method = request.method || "GET";

    try {
      // 1) HEALTH CHECK
      if (method === "GET" && path === "/health") {
        return json({ ok: true, worker: "gold-router", status: "healthy" });
      }

      // 2) TEST ROUTE: pass-imgs -> forward multipart ke preprocess
      else if (method === "POST" && path === "/pass-imgs") {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("multipart/form-data")) {
          return json(
            {
              ok: false,
              error: "Use multipart/form-data with field `file`"
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

        // Forward langsung body + header ke preprocess
        const preprocessResp = await fetch(env.PREPROCESS_URL, {
          method: "POST",
          headers: {
            "Content-Type": contentType
          },
          body: request.body
        });

        return new Response(preprocessResp.body, {
          status: preprocessResp.status,
          headers: {
            "Content-Type":
              preprocessResp.headers.get("Content-Type") || "application/json"
          }
        });
      }

      // 3) FALLBACK
      else {
        return json(
          {
            ok: false,
            error:
              "Unknown route. Use GET /health atau POST /pass-imgs untuk test."
          },
          404
        );
      }
    } catch (err) {
      return json({ ok: false, error: err.message || String(err) }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
