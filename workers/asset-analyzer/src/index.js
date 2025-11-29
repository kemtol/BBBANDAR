// workers/asset-analyzer/src/index.js

import { GOLD_PROMPT } from "./gold-prompt.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const ANALYZER_MODEL = "gpt-5.1"; // reasoning model

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname || "/";
    const method = request.method || "GET";

    try {
      // 1) HEALTH CHECK
      if (method === "GET" && path === "/health") {
        return json({
          ok: true,
          worker: "asset-analyzer",
          status: "healthy",
          model: ANALYZER_MODEL
        });
      }

      // 2) SANITY CHECK (manual prompt, buat ngetes gpt-5.1-thinking)
      if (method === "POST" && path === "/sanity") {
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
              error: "Use application/json with { \"prompt\": \"...\" }"
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

        const answer = await callThinkingModel(
          env.OPENAI_API_KEY,
          [
            {
              role: "system",
              content:
                "You are a helpful, concise assistant. Answer clearly in the same language as the user."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          {
            jsonMode: false
          }
        );

        return json({
          ok: true,
          mode: "sanity_check",
          model: ANALYZER_MODEL,
          prompt,
          answer
        });
      }

      // 3) ENDPOINT UTAMA: dipanggil oleh router → analyze GOLD
      if (method === "POST" && path === "/") {
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
              error:
                "Analyzer expects application/json body from preprocess worker."
            },
            400
          );
        }

        const preprocessPayload = await request.json();

        // Panggil model thinking dengan GOLD_PROMPT + payload preprocess
        const rawContent = await callThinkingModel(
          env.OPENAI_API_KEY,
          [
            {
              role: "system",
              content: GOLD_PROMPT
            },
            {
              role: "user",
              content:
                "Here is the preprocessed GOLD screenshot analysis JSON. " +
                "Use it as hard input evidence and generate the FINAL GOLD ANALYSIS JSON " +
                "strictly following the schema in the instructions.\n\n" +
                "Preprocess JSON:\n```json\n" +
                JSON.stringify(preprocessPayload, null, 2) +
                "\n```"
            }
          ],
          {
            jsonMode: true // minta JSON object
          }
        );

        // rawContent seharusnya string JSON
        let parsed;
        try {
          parsed = JSON.parse(rawContent);
        } catch (e) {
          // Kalau gagal parse, kirim raw content supaya bisa di-debug
          return json(
            {
              ok: false,
              error: "Model did not return valid JSON.",
              raw: rawContent,
              parse_error: e.message
            },
            502
          );
        }

        return json(
          {
            ok: true,
            model: ANALYZER_MODEL,
            gold_json: parsed
          },
          200
        );
      }

      // 4) Fallback route
      return json(
        {
          ok: false,
          error:
            "Unsupported route. Use GET /health, POST /sanity, or POST / (from router)."
        },
        404
      );
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

// ===== Helpers =====

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Wrapper untuk panggil gpt-5.1-thinking via /v1/chat/completions
 * Bisa dipakai untuk:
 *  - mode biasa (teks bebas)
 *  - JSON mode (response_format: json_object)
 */
async function callThinkingModel(apiKey, messages, options = {}) {
  const { jsonMode = false } = options;

  const body = {
    model: "gpt-5.1",
    messages: messages,
    reasoning_effort: "medium"
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const resp = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `OpenAI chat error: ${resp.status} ${resp.statusText} – ${text}`
    );
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";

  return content;
}
