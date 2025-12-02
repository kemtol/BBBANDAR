import { z } from "zod";

export const TechnicalViewSchema = z.object({
  trend_bias: z.enum(["BULLISH", "BEARISH", "RANGE", "MIXED"]),
  key_levels: z.array(
    z.object({
      type: z.enum(["SUPPORT", "RESISTANCE", "LIQUIDITY", "FVG"]),
      level: z.number(),
      timeframe: z.enum(["4H", "1H", "15M", "5M", "1M"]),
      comment: z.string()
    })
  ),
  liquidity_sweeps: z.array(
    z.object({
      direction: z.enum(["UP", "DOWN"]),
      description: z.string(),
      implication: z.string()
    })
  ),
  volume_profile: z.object({
    value_area_high: z.number().nullable(),
    value_area_low: z.number().nullable(),
    poc: z.number().nullable(),
    comment: z.string()
  }),
  setup_quality_score: z.number().min(0).max(10),
  narrative: z.string()
});

export const MacroViewSchema = z.object({
  macro_bias: z.enum(["RISK_ON", "RISK_OFF", "NEUTRAL"]),
  sector_rotation: z.array(
    z.object({
      sector: z.string(),
      flow: z.enum(["INFLOW", "OUTFLOW", "MIXED"]),
      comment: z.string()
    })
  ),
  key_catalysts: z.array(
    z.object({
      type: z.enum(["NEWS", "POLICY", "DATA", "GEOPOLITICS"]),
      description: z.string(),
      timing: z.string(),
      expected_impact: z.enum(["POSITIVE", "NEGATIVE", "UNKNOWN"])
    })
  ),
  cross_asset_signals: z.array(
    z.object({
      asset: z.string(),
      direction: z.string(),
      implication: z.string()
    })
  ),
  macro_risk_commentary: z.string()
});

export const RiskProfileSchema = z.object({
  thesis_clarity: z.number().min(0).max(10),
  probability_of_edge: z.number().min(0).max(1),
  rr_profile: z.object({
    reward_multiple: z.number(),
    estimated_win_rate: z.number()
  }),
  kelly_fraction: z.number(),
  suggested_risk_per_trade_pct: z.number(),
  sizing_comment: z.string(),
  invalidation_level: z.number().nullable(),
  invalidation_reason: z.string()
});

export const PortfolioDecisionSchema = z.object({
  action: z.enum([
    "ENTER_LONG",
    "ENTER_SHORT",
    "SKIP",
    "REDUCE_POSITION",
    "TAKE_PROFIT_PARTIAL"
  ]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
  time_sensitivity: z.enum(["IMMEDIATE", "WAIT_FOR_TRIGGER", "MONITOR_ONLY"]),
  execution_notes: z.string(),
  alignment_comment: z.string()
});

export const FinalPMOutputSchema = z.object({
  ok: z.literal(true),
  role: z.literal("portfolio_manager"),
  asset_symbol: z.string(),
  analysis_mode: z.enum(["INTRADAY", "SWING"]),
  technical_view: TechnicalViewSchema,
  macro_view: MacroViewSchema,
  risk_profile: RiskProfileSchema,
  final_decision: PortfolioDecisionSchema,
  human_readable_summary: z.object({
    whatsapp_style: z.string(),
    key_points: z.array(z.string())
  })
});

export type FinalPMOutput = z.infer<typeof FinalPMOutputSchema>;
