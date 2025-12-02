import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import {
  TechnicalViewSchema,
  MacroViewSchema,
  RiskProfileSchema,
  FinalPMOutputSchema
} from "./schemas";

// ===========================
// 1) TECHNICAL ANALYST AGENT
// ===========================
export const technicalAgent = new Agent({
  name: "Technical Analyst",
  model: "gpt-5.1-chat-latest",
  instructions: `
You are the TECHNICAL ANALYST.

You receive a JSON string as input, representing the analyzer payload.
You ONLY look at:
- price action relative to volume profile
- support & demand area
- liquidity sweeps (stop hunts)
- key level confluence (HTF/LTF)
- fair value gaps (FVG)
- flow of transactions (if provided)

NEVER talk about macro, news, psychology.
ONLY fill TechnicalViewSchema as final output.
Your output MUST strictly match the schema.
`,
  outputType: TechnicalViewSchema
});

export const technicalTool = tool({
  name: "technical_analysis",
  description: "Perform advanced technical analysis on a JSON analyzer payload (string).",
  parameters: z.object({
    // JSON payload as string
    payload: z.string()
  }),
  execute: async ({ payload }) => {
    // payload sudah berbentuk string JSON
    const r = await run(technicalAgent, payload);
    return r.finalOutput;
  }
});

// ======================
// 2) MACRO ANALYST AGENT
// ======================
export const macroAgent = new Agent({
  name: "Macro Analyst",
  model: "gpt-5.1-chat-latest",
  instructions: `
You are the MACRO ANALYST.

You receive a JSON string as input, representing the analyzer payload.
You analyze:
- global risk regime (risk-on/off)
- sector rotation
- cross-asset signals (DXY, US10Y, VIX, credit)
- policy (CB, government)
- news catalysts

You do NOT discuss detailed charts or micro price action.
ONLY fill MacroViewSchema as final output.
`,
  outputType: MacroViewSchema
});

export const macroTool = tool({
  name: "macro_analysis",
  description: "Analyze macro regime, sector rotation, and catalysts from a JSON payload (string).",
  parameters: z.object({
    payload: z.string()
  }),
  execute: async ({ payload }) => {
    const r = await run(macroAgent, payload);
    return r.finalOutput;
  }
});

// ===================
// 3) RISK MANAGER
// ===================
export const riskAgent = new Agent({
  name: "Risk Manager",
  model: "gpt-5.1-chat-latest",
  instructions: `
You are the RISK MANAGER.

You receive a JSON string as input, which may contain:
- original analyzer payload
- and/or embedded summaries from technical & macro views

Your job:
- translate thesis into risk language
- estimate probability_of_edge (0–1)
- set a reasonable reward_multiple and estimated_win_rate
- compute a conservative Kelly fraction
- give suggested_risk_per_trade_pct
- set invalidation_level and invalidation_reason

You DO NOT re-do full technical or macro discussion.
ONLY fill RiskProfileSchema as final output.
`,
  outputType: RiskProfileSchema
});

export const riskTool = tool({
  name: "risk_analysis",
  description: "Create risk profile, invalidation level and position sizing from a JSON payload (string).",
  parameters: z.object({
    payload: z.string()
  }),
  execute: async ({ payload }) => {
    const r = await run(riskAgent, payload);
    return r.finalOutput;
  }
});

// ===========================
// 4) PORTFOLIO MANAGER (PM)
// ===========================
export const portfolioManagerAgent = new Agent({
  name: "Portfolio Manager",
  model: "gpt-5.1-chat-latest",
  instructions: `
You are the PORTFOLIO MANAGER orchestrating three specialist tools:
- technical_analysis
- macro_analysis
- risk_analysis

You receive as input a JSON string representing the analyzer payload
(e.g. asset_symbol, analysis_mode, macro_dashboard, timeframes, news, etc.).

Your workflow (conceptual):
1. Interpret the input JSON string.
2. Call technical_analysis with a payload string (usually the same JSON, or a reduced version).
3. Call macro_analysis with a payload string.
4. Build a richer JSON string combining:
   - original analyzer payload
   - a short summary of technical_view
   - a short summary of macro_view
5. Call risk_analysis with that richer JSON string as its payload.
6. Merge all three views into a single FINAL portfolio decision.

Decision logic:
- If technical and macro clearly align, and risk_profile.probability_of_edge >= 0.5:
  - consider ENTER_LONG / ENTER_SHORT.
- If technical and macro conflict or probability_of_edge < 0.4:
  - prefer SKIP or MONITOR_ONLY.
- If trend already extended but edge good:
  - consider WAIT_FOR_TRIGGER or TAKE_PROFIT_PARTIAL.
- Always be more conservative for SWING vs INTRADAY.

Your final output MUST:
- follow FinalPMOutputSchema EXACTLY.
- be STRICT JSON (no markdown, no extra text).
- include a short punchy Bahasa/English mix in "human_readable_summary.whatsapp_style".
`,
  tools: [technicalTool, macroTool, riskTool],
  outputType: FinalPMOutputSchema
});
