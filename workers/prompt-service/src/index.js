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
        endpoints: ["/prompts/ai-analytics"],
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

    return jsonResponse({ error: "Not Found" }, 404);
  }
};
