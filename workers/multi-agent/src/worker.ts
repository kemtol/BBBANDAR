import { run } from "@openai/agents";
import { setDefaultOpenAIKey } from "@openai/agents-openai";
import { portfolioManagerAgent } from "./agents";
import type { FinalPMOutput } from "./schemas";

interface Env {
  OPENAI_API_KEY: string;
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
        const payload = await request.json();

        // Kirim JSON analyzer payload sebagai STRING ke Portfolio Manager
        const result = await run(
          portfolioManagerAgent,
          JSON.stringify(payload)
        );

        const finalOutput = result.finalOutput as FinalPMOutput;

        return new Response(JSON.stringify(finalOutput, null, 2), {
          status: 200,
          headers: { "content-type": "application/json" }
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
          error: err?.message ?? String(err)
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }
};
