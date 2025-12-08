// workers/multi-agent/src/worker.ts
import { run } from "@openai/agents";
import { setDefaultOpenAIKey } from "@openai/agents-openai";
import { portfolioManagerAgent } from "./agents";
// TODO: kalau agent khusus DRZ sudah siap, import di sini:
/// import { deadRetailZoneAgent } from "./agents-dead-retail";

import type { FinalPMOutput } from "./schemas";

interface Env {
  OPENAI_API_KEY: string;
}

// Payload minimal yang kita expect dari analyzer step
interface AnalyzerPayload {
  trace_id?: string;
  analysis_mode?: string;
  asset_type?: string;
  asset_symbol?: string;
  charts?: unknown[];

  // kalau mau, bisa tambah field lain (opsional):
  // macro_dashboard?: unknown;
  // news_set?: unknown;
  // risk_profile?: unknown;
  // raw_meta?: unknown;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: any
  ): Promise<Response> {
    try {
      // Bridge CF env → Agents SDK
      setDefaultOpenAIKey(env.OPENAI_API_KEY);

      if (request.method === "POST") {
        // 🔥 FIX: cast dari unknown → AnalyzerPayload
        const payload = (await request.json()) as AnalyzerPayload;
        const traceId = payload.trace_id || "no-trace";
        const mode = (payload.analysis_mode || "SWING").toUpperCase();

        // 🧠 Pilih agent sesuai analysis_mode
        const agentToRun =
          mode === "DEAD_RETAIL_ZONE"
            ? /* deadRetailZoneAgent */ portfolioManagerAgent // TODO: ganti ke agent DRZ beneran
            : portfolioManagerAgent;

        console.log(
          "[multi-agent:worker] INPUT → agent",
          traceId,
          {
            mode,
            analysis_mode: payload.analysis_mode,
            asset_type: payload.asset_type,
            asset_symbol: payload.asset_symbol,
            charts_len: Array.isArray(payload.charts)
              ? payload.charts.length
              : 0,
          }
        );

        // Kirim JSON analyzer payload sebagai STRING ke agent terpilih
        const result = await run(
          agentToRun,
          JSON.stringify(payload)
        );

        const finalOutput = result.finalOutput as FinalPMOutput;

        console.log(
          "[multi-agent:worker] OUTPUT ← agent",
          traceId,
          {
            role: finalOutput.role,
            action: finalOutput.final_decision?.action,
            trend_bias: finalOutput.technical_view?.trend_bias,
            note: finalOutput.technical_view?.narrative?.slice(0, 120),
          }
        );

        return new Response(JSON.stringify(finalOutput, null, 2), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(
        "Multi-agent orchestrator worker. POST JSON analyzer payload to this URL.",
        { status: 200 }
      );
    } catch (err: any) {
      console.error("Multi-agent orchestrator error:", err);
      return new Response(
        JSON.stringify({
          ok: false,
          error: err?.message ?? String(err),
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  },
};
