const PROMPTS = {
  version: "2024-03-18",
  prompt: {
    overview: "Analisis data broker-flow dan orderflow untuk menyusun rekomendasi singkat dalam Bahasa Indonesia.",
    tone: "Profesional, ringkas, tidak bertele-tele, gunakan Bahasa Indonesia yang mudah dipahami tanpa campuran istilah Inggris kecuali istilah pasar populer (misal: breakout, support).",
    confidence: {
      score_range: [0, 1],
      buckets: [
        { min: 0.0, max: 0.2, label: "Very Low", color: "#dc2626", guidance: "Hanya informatif. Jangan ambil keputusan berdasarkan sinyal ini." },
        { min: 0.2, max: 0.4, label: "Low", color: "#f97316", guidance: "Butuh verifikasi manual tambahan sebelum bertindak." },
        { min: 0.4, max: 0.7, label: "Medium", color: "#facc15", guidance: "Menarik, tetapi tetap cantumkan risiko dan syarat validasi." },
        { min: 0.7, max: 0.9, label: "High", color: "#22c55e", guidance: "Direkomendasikan dengan tetap menyebutkan faktor penentu keberhasilan." },
        { min: 0.9, max: 1.01, label: "Very High", color: "#16a34a", guidance: "Keyakinan sangat tinggi, fokus pada katalis utama dan tindak lanjut yang jelas." }
      ]
    },
    sections: {
      summary: "Headline satu kalimat mengenai kondisi terbaru dan peluang utama.",
      analysis_steps: [
        "Evaluasi arus dana (flow) dan state smart money.",
        "Periksa dukungan orderflow intraday (delta, absorption, momentum).",
        "Identifikasi level harga penting atau trigger aksi.",
        "Tentukan risiko utama (misal: volume menurun, volatilitas tinggi)."
      ],
      recommendation: {
        fields: [
          {
            key: "position",
            label: "Posisi",
            type: "enum",
            options: ["Buy", "Sell", "Hold"],
            description: "Rekomendasi aksi utama berdasarkan sinyal." }
          ,{
            key: "confidence",
            label: "Confidence Score",
            type: "float",
            description: "Nilai antara 0 dan 1 yang menandakan tingkat keyakinan." },
          {
            key: "rationale",
            label: "Alasan",
            type: "string",
            description: "Penjelasan ringkas mengapa posisi tersebut disarankan." }
        ]
      },
      risks: [
        "Sebutkan minimal satu risiko yang bisa membatalkan skenario.",
        "Cantumkan indikator pembatal (invalidate condition) jika ada."
      ]
    },
    providers: {
      openai: {
        model: "gpt-4.1-mini",
        system_directives: [
          "Gunakan bahasa yang jelas, hindari jargon teknis berlebihan.",
          "Tampilkan hasil dalam paragraf singkat dengan bullet jika diperlukan.",
          "Cantumkan confidence score eksplisit dan mapping labelnya.",
          "Jangan membuat asumsi data baru di luar konteks yang diberikan.",
          "Jika data tidak cukup, jelaskan keterbatasannya dan minta pengguna memverifikasi." 
        ],
        examples: [
          {
            input: {
              ticker: "BBRI",
              flow_state: "ACCUMULATION",
              orderflow: {
                delta_pct: 68,
                absorption_score: 12.4,
                divergence: "positif"
              }
            },
            output: {
              summary: "BBRI kembali diborong asing dengan dukungan orderflow yang solid.",
              confidence: 0.78,
              position: "Buy",
              rationale: "Arus beli asing konsisten 3 hari, absorption tinggi di area 5.250.",
              risks: ["Jika volume turun di bawah rata-rata atau harga jatuh di bawah 5.180"]
            }
          }
        ]
      },
      grok: {
        model: "grok-beta",
        system_directives: [
          "Tetap gunakan Bahasa Indonesia yang natural.",
          "Jangan menyebutkan atau merujuk identitas model (misal 'Grok').",
          "Tulis ringkasan padat dengan highlight utama di awal kalimat.",
          "Jika ada keraguan, tonjolkan di bagian risiko." 
        ],
        examples: []
      }
    }
  }
};

// ─── Claude Screener Scoring Prompt ───
const CLAUDE_SCREENER_SCORE = {
  version: "2025-06-01",
  model: "claude-opus-4-6",
  max_tokens: 16000,
  prompt: {
    system: `Anda adalah expert analis pasar saham Indonesia dengan specialization di orderflow & fund flow analysis.

TUGAS: Score setiap emiten dalam dataset 0-100, merepresentasikan probabilitas bahwa emiten tersebut memiliki potensi naik +5% dalam 5 hari ke depan.

DATA FIELD REFERENCE (setiap emiten memiliki field berikut, dalam format compact key):
- s (symbol): kode emiten
- g (growth_pct): perubahan harga hari ini (%)
- fq (freq): jumlah transaksi hari ini
- sm[0..3]: Smart Money net flow (Foreign+Local) untuk window 2D, 5D, 10D, 20D (dalam Rupiah)
- fn[0..3]: Foreign net flow saja untuk window 2D, 5D, 10D, 20D
- ln[0..3]: Local fund net flow saja untuk window 2D, 5D, 10D, 20D
- fl[0..3] (flow): Flow Score komposit untuk window 2D, 5D, 10D, 20D (0-7 scale)
- ef[0..3] (effort): Effort Z-Score untuk window 2D, 5D, 10D, 20D
- vw[0..3] (vwap): VWAP Position Z-Score untuk window 2D, 5D, 10D, 20D
- ng[0..3] (ngr): Net Growth Rate untuk window 2D, 5D, 10D, 20D
- rv[0..3] (rvol): Relative Volume untuk window 2D, 5D, 10D, 20D (1.0 = normal)
- cm[0..3] (cvd_multi): Cumulative Volume Delta multi-window 2D, 5D, 10D, 20D
- of (orderflow): { delta_pct, mom_pct, absorb, cvd, net_value } — intraday orderflow snapshot
- q (quadrant): Q1 (bullish+volume) / Q2 (bullish+low vol) / Q3 (bearish+volume) / Q4 (bearish+low vol)
- st (state): ACCUMULATION / READY_MARKUP / TRANSITION / OFF_THE_LOW / POTENTIAL_TOP / DISTRIBUTION / NEUTRAL
- tr (trend): { vwapUp, effortUp, ngrUp, avg2, avg5, avg10, avg20 }

METODOLOGI:
1. CROSS-SECTIONAL CONTEXT
   - Anda diberikan seluruh universe emiten dalam satu batch.
   - Bandingkan relative strength antar emiten, bukan nilai absolut.
   - Top 20% emiten harus mendapat score 60+, bottom 20% harus < 40.

2. SIGNAL WEIGHTING
   a) Smart Money Flow (25% weight)
      - sm[] = fn[] + ln[]. Gunakan breakdown fn[]/ln[] untuk menentukan kualitas akumulasi.
      - Foreign-led (fn[i] > ln[i] untuk semua window): kualitas tertinggi, bonus +5 tambahan.
      - Positif konsisten: sm[0] > 0 && sm[1] > 0 && sm[2] > 0 && sm[3] > 0 → bonus +20 points
      - Positif tapi declining: sm[0] > sm[1] > sm[3] → bonus +10 points
      - Kumulatif positif (sm[3] > 0) → bonus +5 points

   b) Effort Z-Score (20% weight)
      - ef[0] > 1.0: structured buying pressure → +15 points
      - ef[0] > 0.5: weak buying → +8 points
      - ef[0] < 0: selling pressure → -10 points
      - Multi-window confirmation: ef[0] > ef[1] > ef[2] → strengthening → +5 points

   c) Orderflow Intraday (15% weight)
      - of.delta_pct > 60%: strong bullish delta → +12 points
      - of.mom_pct > 50%: momentum positive → +8 points
      - of.absorb > 10: buying absorption → +5 points
      - of.cvd > 500000: volume backing → +3 points
      - q = "Q1": ideal (bullish + high volume) → +5 points
      - q = "Q3": bearish + volume → -8 points

   d) Volume & Price Momentum (15% weight)
      - rv[0] >= 2.0: volume surge → +10 points
      - rv[0] >= 1.5: above average → +5 points
      - rv[0] < 0.5: very low volume → -5 points (low conviction)
      - g > 3: strong positive day → +5 points
      - g < -3: significant drop → -5 points
      - cm[] trending up (cm[0] > cm[1] > cm[2]): accumulation confirmation → +5 points

   e) State & Liquidity (15% weight)
      - st = "ACCUMULATION": +10 points
      - st = "READY_MARKUP": +8 points
      - st = "OFF_THE_LOW": +6 points
      - st = "DISTRIBUTION": -15 points (cap max score to 15)
      - of.net_value > 1000000: good liquidity → +5 points
      - of.net_value < 100000: poor liquidity → -5 points

   f) Trend Quality (10% weight)
      - tr.vwapUp = true: quality uptrend → +5 points
      - tr.effortUp = true: effort strengthening → +3 points
      - tr.ngrUp = true: +2 points
      - vw[] all positive (> 0): price above VWAP across all windows → +3 points
      - ng[] improving (ng[0] > ng[3]): +2 points

3. CONSERVATIVE CAPPING
   - Score range: 5-95 (avoid extreme confidence)
   - If st = "DISTRIBUTION" regardless of other signals → cap to max 15
   - If of.net_value < 50000 AND score > 50 → cap to 45 (liquidity risk)
   - If rv[0] < 0.3 AND score > 50 → cap to 45 (no volume conviction)

OUTPUT FORMAT (STRICTLY JSON):
{
  "scores": {
    "BBRI": 78,
    "TLKM": 62,
    ...semua emiten harus ada score...
  },
  "top5": ["SYMBOL1","SYMBOL2","SYMBOL3","SYMBOL4","SYMBOL5"],
  "summary": {
    "high_confidence": 45,
    "medium_confidence": 320,
    "low_confidence": 322
  }
}

CONSTRAINTS:
- Return ONLY valid JSON. No markdown, no explanation text, no code fences.
- Every symbol in input must have a score in output.
- Scores must be integer 0-100.
- "high_confidence" = count scores >= 70, "medium_confidence" = count 50-69, "low_confidence" = count < 50.
- "top5" = top 5 symbols with highest score.`,
    user_template: `Score semua {universe_size} emiten berikut berdasarkan potensi naik +5% dalam 5 hari ke depan.

DATA:
{candidates_json}`
  }
};

function buildPromptResponse(provider) {
  const { version, prompt } = PROMPTS;
  const base = {
    version,
    prompt: {
      overview: prompt.overview,
      tone: prompt.tone,
      confidence: prompt.confidence,
      sections: prompt.sections,
      providers: {}
    }
  };

  if (!provider) {
    base.prompt.providers = prompt.providers;
    return base;
  }

  const key = provider.toLowerCase();
  const providerConfig = prompt.providers[key];
  if (!providerConfig) {
    return null;
  }

  base.prompt.providers[key] = providerConfig;
  return base;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse({
        service: "prompt-service",
        endpoints: ["/prompts/ai-analytics", "/prompts/claude-screener-score"],
        version: PROMPTS.version
      });
    }

    if (url.pathname === "/prompts/ai-analytics") {
      const provider = url.searchParams.get("provider");
      const payload = buildPromptResponse(provider);

      if (!payload) {
        return jsonResponse({ error: "Provider not found" }, 404);
      }

      return jsonResponse(payload);
    }

    if (url.pathname === "/prompts/claude-screener-score") {
      return jsonResponse(CLAUDE_SCREENER_SCORE);
    }

    return jsonResponse({ error: "Not Found" }, 404);
  }
};
