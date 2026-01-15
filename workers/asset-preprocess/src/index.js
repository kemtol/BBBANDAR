/**
 * @worker asset-preprocess
 * @objective Preprocesses assets/images using OpenAI models (GPT-4o) for analysis, tagging, or transformation.
 *
 * @endpoints
 * - POST /analyze -> Analyze image content (internal)
 * - POST /chat -> Chat completion for asset context (internal)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: none
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: Request Body, OpenAI API
 * - writes: Response JSON, OpenAI API
 *
 * @relations
 * - upstream: Asset Analyzer / Router
 * - downstream: OpenAI API
 *
 * @success_metrics
 * - AI Response time
 * - Token usage/Cost
 *
 * @notes
 * - Uses external OpenAI API (`https://api.openai.com/v1/chat/completions`).
 */
import {
  PREPROCESS_CHART_PROMPT,
  PREPROCESS_MACRO_NEWS_PROMPT,
  MACRO_CORRELATION_SENTIMENT_PROMPT,
  SmartMoney
} from "./preprocess-prompt.js";

// =====================================
// CONFIG OPENAI (chat completions + vision)
// =====================================
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const CHAT_MODEL = "gpt-4o";

// ======================
// Helpers umum
// ======================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function requireOpenAI(env) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in environment");
  }
  if (!env.TEMP_BUCKET) {
    throw new Error("Missing R2 binding TEMP_BUCKET");
  }
  if (!env.R2_PUBLIC_BASE_URL) {
    throw new Error("Missing R2_PUBLIC_BASE_URL in environment");
  }
}

async function readJsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Use application/json and send raw_input JSON in the body.");
  }
  return await request.json();
}

// Decode data:image/...;base64,... → Uint8Array
function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("Invalid data URL for image");
  }
  const mimeType = match[1];
  const base64 = match[2];
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { bytes, mimeType };
}

// ======================
// R2: simpan gambar + return URL publik
// ======================
async function saveToR2AndGetPublicUrl(env, key, dataUrl) {
  try {
    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return null;

    const contentType = matches[1];
    const buffer = Uint8Array.from(atob(matches[2]), c => c.charCodeAt(0));

    await env.TEMP_BUCKET.put(key, buffer, {
      httpMetadata: { contentType }
    });

    console.log(`[R2] Saved: ${key}`);

    // env.R2_PUBLIC_BASE_URL contoh: "https://cdn.qqquanta.com"
    // → URL final: https://cdn.qqquanta.com/2025-11-30/xxx_filename.jpg
    const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
    return `${base}/${key}`;
  } catch (err) {
    console.error(`[R2] Error saving ${key}:`, err);
    return null;
  }
}

// ======================
// Build content user (chat + image_url)
// ======================
async function buildUserMessageContent(env, raw_input, categories) {
  // 1) Clone metadata & replace data base64 → placeholder
  const metadataContext = JSON.parse(JSON.stringify(raw_input));

  if (metadataContext.screenshots) {
    ["charts", "macro", "news"].forEach((cat) => {
      if (Array.isArray(metadataContext.screenshots[cat])) {
        metadataContext.screenshots[cat] =
          metadataContext.screenshots[cat].map((item) => {
            const clone = { ...item };
            if ("data" in clone) {
              clone.data = "[IMAGE_STORED_IN_R2]";
            }
            return clone;
          });
      }
    });
  }

  const content = [
    {
      type: "text",
      text:
        "Here is the metadata JSON (without base64). " +
        "Images are hosted on R2 via public URLs for this gate.\n\n" +
        JSON.stringify(metadataContext)
    }
  ];

  // 🔥 NEW: kumpulkan URL per kategori
  const urlsByCategory = {};

  const attachImagesForCategory = async (category) => {
    const list = raw_input.screenshots?.[category];
    if (!Array.isArray(list)) return;

    urlsByCategory[category] = [];

    for (let i = 0; i < list.length; i++) {
      const img = list[i];
      const dataUrl = img.data;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) continue;

      const filename = img.name || `${category}_${i + 1}.png`;
      const dateFolder = new Date().toISOString().split("T")[0];
      const key = `${dateFolder}/${Date.now()}_${category}_${i + 1}_${filename}`;

      const publicUrl = await saveToR2AndGetPublicUrl(env, key, dataUrl);
      if (!publicUrl) continue;

      // simpan ke list untuk dipakai analyzer
      urlsByCategory[category].push({
        index: img.index ?? i,
        slot: img.slot ?? null,
        name: filename,
        image_url: publicUrl
      });

      // dan juga kirim ke Vision
      content.push({
        type: "image_url",
        image_url: { url: publicUrl }
      });
    }
  };

  for (const c of categories) {
    await attachImagesForCategory(c);
  }

  console.log("==========================================");
  console.log("[asset-preprocess] BUILD VISION CONTENT (chat + image_url)");
  console.log(`- Categories: ${categories.join(", ")}`);
  console.log(`- Total items: ${content.length}`);
  console.log("==========================================");

  // 🔥 RETURN KEDUANYA
  return { content, urlsByCategory };
}


// ======================
// Call OpenAI (GATE runner)
// ======================
async function runVisionPreprocess({ env, raw_input, categories, systemPrompt }) {
  const { content: userMessageContent, urlsByCategory } =
    await buildUserMessageContent(env, raw_input, categories);

  const payload = {
    model: CHAT_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessageContent }
    ]
  };

  console.log("==========================================");
  console.log("[asset-preprocess] PAYLOAD TO OPENAI (chat):");
  console.log(JSON.stringify(payload, null, 2));
  console.log("==========================================");

  const openaiResp = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!openaiResp.ok) {
    const errText = await openaiResp.text();
    console.error("[asset-preprocess] OpenAI Error Status:", openaiResp.status);
    console.error("[asset-preprocess] OpenAI Raw Error Body:", errText);
    throw new Error(`OpenAI API error (preprocess) status=${openaiResp.status}`);
  }

  const data = await openaiResp.json();
  const content = data.choices?.[0]?.message?.content || "";

  console.log("==========================================");
  console.log("[asset-preprocess] RAW MODEL OUTPUT:");
  console.log(content);
  console.log("==========================================");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error("[asset-preprocess] JSON PARSE ERROR:", content);
    throw new Error("Failed to parse model output as JSON");
  }

  console.log(
    "[asset-preprocess] PREPROCESS RESULT:",
    JSON.stringify(parsed, null, 2)
  );

  // 🔥 NEW: tempelkan image_url ke output gate
  parsed.screenshots = urlsByCategory;

  return parsed;
}


// =====================================
// MAIN FETCH HANDLER
// =====================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname || "/";
    const method = request.method || "GET";

    try {
      // 1) HEALTH
      if (method === "GET" && path === "/health") {
        return json({ ok: true, worker: "asset-preprocess", status: "healthy" });
      }

      // 2) SANITY (pakai chat completions biasa)
      if (method === "POST" && path === "/sanity") {
        requireOpenAI(env);
        const body = await readJsonBody(request);
        const prompt = (body.prompt || "").toString().trim();
        if (!prompt) {
          return json({ ok: false, error: "Field `prompt` is required in JSON body." }, 400);
        }

        const payload = {
          model: CHAT_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant. Answer briefly and clearly. Use the same language as the user."
            },
            { role: "user", content: prompt }
          ]
        };

        const openaiResp = await fetch(OPENAI_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
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

        return json({ ok: true, mode: "sanity_check", prompt, answer });
      }

      // 3) GATE 1 ONLY
      if (method === "POST" && path === "/charts") {
        requireOpenAI(env);
        const raw_input = await readJsonBody(request);
        const gate1 = await runVisionPreprocess({
          env,
          raw_input,
          categories: ["charts", "macro"],
          systemPrompt: PREPROCESS_CHART_PROMPT
        });
        return json(gate1);
      }

      // 4) GATE 2 ONLY
      if (method === "POST" && path === "/macro-news") {
        requireOpenAI(env);
        const raw_input = await readJsonBody(request);
        const gate2 = await runVisionPreprocess({
          env,
          raw_input,
          categories: ["macro", "news"],
          systemPrompt: PREPROCESS_MACRO_NEWS_PROMPT
        });
        return json(gate2);
      }

      // 5) MACRO SENTIMENT ONLY
      if (method === "POST" && path === "/macro-sentiment") {
        requireOpenAI(env);
        const raw_input = await readJsonBody(request);
        const macroSent = await runVisionPreprocess({
          env,
          raw_input,
          categories: ["macro"],
          systemPrompt: MACRO_CORRELATION_SENTIMENT_PROMPT
        });
        return json(macroSent);
      }

      // 6) ORCHESTRATOR: /pass-imgs
      if (method === "POST" && (path === "/pass-imgs" || path === "/")) {
        requireOpenAI(env);
        const raw_input = await readJsonBody(request);

        const gate1 = await runVisionPreprocess({
          env,
          raw_input,
          categories: ["charts", "macro"],
          systemPrompt: PREPROCESS_CHART_PROMPT
        });

        if (!gate1.ok || gate1.ready_for_analysis === false) {
          return json(gate1);
        }

        const gate2 = await runVisionPreprocess({
          env,
          raw_input,
          categories: ["macro", "news"],
          systemPrompt: PREPROCESS_MACRO_NEWS_PROMPT
        });

        const finalReady =
          gate1.ready_for_analysis === true &&
          gate2.ok === true &&
          gate2.ready_for_analysis === true;

        const finalReason =
          (!gate1.ok || gate1.ready_for_analysis === false
            ? gate1.reason_if_not_ready || "Gate 1 not ready."
            : !gate2.ok || gate2.ready_for_analysis === false
              ? gate2.reason_if_not_ready || "Macro/News (Gate 2) not ready."
              : null);

        const merged = {
          trace_id: raw_input.trace_id || null,                    // 🔥 carry trace
          ok: gate1.ok && gate2.ok,
          mode: gate1.mode || "asset_analysis",
          analysis_mode: gate1.analysis_mode,
          ready_for_analysis: finalReady,
          reason_if_not_ready: finalReason,
          input_summary: gate1.input_summary || {
            asset: raw_input.pair || null,
            timeframes_detected: [],
            timeframes_missing: [],
            alignment_status: "UNKNOWN",
            macro_inputs_count: raw_input.screenshot_counts?.macro ?? 0
          },
          news: {
            has_news: gate2.news?.status === "valid",
            summary_for_analyzer:
              gate2.news?.summary_for_analyzer ||
              gate1.news?.summary_for_analyzer ||
              ""
          },
          gate2_macro: gate2.macro || null,
          gate2_news: gate2.news || null,
          meta: {
            preprocess_version: "v2.3-orchestrated-image-url",
            gate1_version: gate1.meta?.preprocess_version || null,
            gate2_version: gate2.meta?.preprocess_version || null
          },
          // 🔥 NEW: kirim URL gambar ke FE
          screenshots: {
            charts: gate1.screenshots?.charts ?? [],
            macro: gate1.screenshots?.macro ?? [],
            // optional, kalau mau
            news: gate2.screenshots?.news ?? []
          },
          // 🔥 optional tapi sangat berguna:
          gate1_raw: gate1,
          gate2_raw: gate2
        };

        console.log("[asset-preprocess]/pass-imgs merged", merged.trace_id, {
          charts_len: merged.screenshots.charts.length,
          macro_len: merged.screenshots.macro.length,
          news_len: merged.screenshots.news.length
        });

        return json(merged);
      }

      // 7) RECV-IMGS test (debug multipart)
      if (method === "POST" && path === "/recv-imgs") {
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

      // 8) FALLBACK
      return json(
        {
          ok: false,
          error:
            "Unsupported route. Use GET /health, POST /sanity, POST /pass-imgs, POST /charts, POST /macro-news, POST /macro-sentiment, atau POST /recv-imgs."
        },
        404
      );
    } catch (err) {
      console.error("[asset-preprocess] ERROR:", err);
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
