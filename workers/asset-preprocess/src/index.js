//==============================================
// workers/asset-preprocess/src/index.js
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


import { PREPROCESS_SYSTEM_PROMPT } from "./preprocess-prompt.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const CHAT_MODEL = "gpt-4.1-mini"; // murah dan cukup untuk preprocess

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname || "/";
    const method = request.method || "GET";

    try {
      // 1) HEALTH CHECK
      if (method === "GET" && path === "/health") {
        return json({ ok: true, worker: "asset-preprocess", status: "healthy" });
      }

      // 2) SANITY CHECK (prompt bebas, bukan preprocess logic)
      else if (method === "POST" && path === "/sanity") {
        if (!env.OPENAI_API_KEY) {
          return json(
            { ok: false, error: "Missing OPENAI_API_KEY in environment" },
            500
          );
        }

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json(
            {
              ok: false,
              error: 'Use application/json with { "prompt": "..." }'
            },
            400
          );
        }

        const body = await request.json();
        const prompt = (body.prompt || "").toString().trim();

        if (!prompt) {
          return json(
            { ok: false, error: "Field `prompt` is required in JSON body." },
            400
          );
        }

        const openaiResp = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: CHAT_MODEL,
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful assistant. Answer briefly and clearly. Use the same language as the user."
              },
              {
                role: "user",
                content: prompt
              }
            ]
          })
        });

        if (!openaiResp.ok) {
          const errText = await openaiResp.text();
          return json(
            {
              ok: false,
              error: "OpenAI API error",
              status: openaiResp.status,
              details: errText
            },
            502
          );
        }

        const data = await openaiResp.json();
        const answer = data.choices?.[0]?.message?.content || "";

        return json({
          ok: true,
          mode: "sanity_check",
          prompt,
          answer
        });
      }

      // 3) ENDPOINT UTAMA PREPROCESS (RAW JSON → GATING JSON)
      else if (method === "POST" && path === "/") {
        if (!env.OPENAI_API_KEY) {
          return json(
            { ok: false, error: "Missing OPENAI_API_KEY in environment" },
            500
          );
        }

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
          return json(
            {
              ok: false,
              error: "Use application/json and send raw_input JSON in the body."
            },
            400
          );
        }

        // "Bahan mentah" dari router (nanti bisa berisi hasil vision/ocr)
        const raw_input = await request.json();
        console.log("[asset-preprocess] raw_input:", JSON.stringify(raw_input, null, 2));
        
        const openaiResp = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: CHAT_MODEL,
            temperature: 0,
            messages: [
              {
                role: "system",
                content: PREPROCESS_SYSTEM_PROMPT
              },
              {
                role: "user",
                content:
                  "Here is the raw_input JSON. Transform it into the defensive gating JSON described in the system prompt:\n\n" +
                  JSON.stringify(raw_input)
              }
            ]
          })
        });

        if (!openaiResp.ok) {
          const errText = await openaiResp.text();
          return json(
            {
              ok: false,
              error: "OpenAI API error (preprocess)",
              status: openaiResp.status,
              details: errText
            },
            502
          );
        }

        const data = await openaiResp.json();
        const content = data.choices?.[0]?.message?.content || "";

        // Model harusnya mengembalikan pure JSON string → kita parse biar valid
        let gating;
        try {
          gating = JSON.parse(content);
        } catch (e) {
          return json(
            {
              ok: false,
              error: "Failed to parse model output as JSON",
              raw: content
            },
            500
          );
        }

        return json(gating);
      }

      // 4) TEST: TERIMA GAMBAR DARI ROUTER (MULTIPART)
      else if (method === "POST" && path === "/recv-imgs") {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("multipart/form-data")) {
          return json(
            { ok: false, error: "Use multipart/form-data dengan field `file`" },
            400
          );
        }

        const form = await request.formData();
        const files = form
          .getAll("file")
          .filter((f) => f && typeof f !== "string");

        const fileInfos = files.map((f, idx) => ({
          index: idx,
          name: f.name || null,
          type: f.type || null,
          size: f.size ?? null
        }));

        return json({
          ok: true,
          worker: "asset-preprocess",
          message: "gambar diterima",
          file_count: fileInfos.length,
          files: fileInfos
        });
      }

      // 5) FALLBACK
      else {
        return json(
          {
            ok: false,
            error:
              "Unsupported route. Use GET /health, POST /sanity, POST / (JSON), atau POST /recv-imgs (multipart)."
          },
          404
        );
      }
    } catch (err) {
      return json(
        {
          ok: false,
          error: err.message || String(err)
        },
        500
      );
    }
  }
};

// Helper: JSON response
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
