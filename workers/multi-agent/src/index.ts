// workers/multi-agent/src/index.ts
/// <reference types="@cloudflare/workers-types" />

export interface Env {
  // Opsional: set ini di wrangler.toml untuk prod
  // ASSET_ANALYZER_URL = "https://asset-analyzer.mkemalw.workers.dev"
  ASSET_ANALYZER_URL?: string;
}

const START_TIME = Date.now();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Simple router
    if (pathname === "/health") {
      return handleHealth();
    }

    if (pathname === "/sanity") {
      return handleSanity(request);
    }

    // Route utama multi-agent → analyzer
    if (pathname === "/multi-agent" || pathname === "/analyze") {
      return handleMain(request, env, ctx);
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: "Not found",
        path: pathname,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};

function handleHealth(): Response {
  const uptimeMs = Date.now() - START_TIME;

  const body = {
    ok: true,
    service: "multi-agent",
    version: "v1",
    uptime_ms: uptimeMs,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleSanity(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Use POST for /sanity",
      }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  let json: any;
  try {
    json = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Invalid JSON body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const prompt = typeof json?.prompt === "string" ? json.prompt : null;

  return new Response(
    JSON.stringify({
      ok: true,
      service: "multi-agent",
      mode: "sanity",
      echo_prompt: prompt,
      note: "Sanity OK (multi-agent)",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Normalized input minimal yang akan dikirim ke analyzer.
 * Ini sengaja dibuat "longgar" dulu, nanti bisa kamu ketatkan sesuai JSON_SCHEMA analyzer.
 */
interface AnalyzerInput {
  analysis_mode: string; // "INTRADAY" | "SWING" | dsb
  asset_type: string;    // "GOLD" | "OIL" | "NASDAQ" | dsb
  asset_symbol: string;

  charts?: any;
  macro_dashboard?: any;
  news_set?: any;
  risk_profile?: any;

  knowledge_file_reference?: string;
  raw_meta?: any;
}

// Helper: build payload buat analyzer dari body FE
function normalizeToAnalyzerInput(body: any): AnalyzerInput {
  const analysis_mode =
    (body?.analysis_mode as string) ??
    (body?.mode as string) ??
    "SWING";

  const asset_symbol =
    (body?.asset_symbol as string) ??
    (body?.symbol as string) ??
    "";

  const asset_type =
    (body?.asset_type as string) ??
    (body?.asset_class as string) ??
    "GOLD";

  return {
    analysis_mode,
    asset_type,
    asset_symbol,
    charts: body?.charts ?? body?.images ?? null,
    macro_dashboard:
      body?.macro_dashboard ??
      body?.macro ??
      {
        items: [],
        summary_for_analyzer: "No macro data provided by multi-agent.",
      },
    news_set:
      body?.news_set ??
      {
        has_news: false,
        items: [],
        summary_for_analyzer: "No news provided by multi-agent.",
      },
    risk_profile:
      body?.risk_profile ??
      {
        account_type: body?.account_type ?? "UNKNOWN",
        max_risk_per_trade_usd: body?.max_risk_per_trade_usd ?? 0,
      },
    knowledge_file_reference:
      body?.knowledge_file_reference ??
      body?.knowledge_key ??
      undefined,
    raw_meta: {
      source: "multi-agent",
      received_at: new Date().toISOString(),
    },
  };
}

// route utama multi-agent: terima payload → normalize → call analyzer → balikin result
async function handleMain(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Use POST for /multi-agent",
      }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Invalid JSON body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const analyzerInput = normalizeToAnalyzerInput(body);
  const traceId = (body && body.trace_id) || "no-trace";

  console.log("[multi-agent:index] analyzerInput", traceId, {
    analysis_mode: analyzerInput.analysis_mode,
    asset_type: analyzerInput.asset_type,
    asset_symbol: analyzerInput.asset_symbol,
    charts_len: analyzerInput.charts?.length ?? 0,
    has_macro: !!analyzerInput.macro_dashboard,
    has_news: !!analyzerInput.news_set
  });

  // Default ke localhost untuk dev, bisa di-override via Env di prod
  const analyzerUrl =
    env.ASSET_ANALYZER_URL ?? "http://127.0.0.1:8788";

  let analyzerRes: Response;
  try {
    analyzerRes = await fetch(analyzerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(analyzerInput),
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        stage: "call_analyzer",
        error: "Failed to reach analyzer worker",
        details: String(e),
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!analyzerRes.ok) {
    const text = await analyzerRes.text().catch(() => null);

    return new Response(
      JSON.stringify({
        ok: false,
        stage: "analyzer_error",
        status: analyzerRes.status,
        error: "Analyzer worker returned non-2xx",
        body: text,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  let analyzerJson: any = null;
  try {
    analyzerJson = await analyzerRes.json();
  } catch {
    // Kalau bukan JSON, kirim raw text saja
    const text = await analyzerRes.text().catch(() => null);
    return new Response(
      JSON.stringify({
        ok: false,
        stage: "analyzer_invalid_json",
        body: text,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Sukses → balikin ke FE dengan metadata
  return new Response(
    JSON.stringify({
      ok: true,
      service: "multi-agent",
      stage: "analyzer_result",
      analyzer_input: analyzerInput,
      result: analyzerJson,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
