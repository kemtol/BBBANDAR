# 0006 — Prompt Service Worker

> **Status**: Draft → Implemented
>
> **Owner**: mkemalw • **Revision**: 2024-03-XX

---

## 1. Purpose

Historically, AI prompt templates disimpan sebagai file `.txt` di bucket R2 (`workers/prompt/`). Pendekatan ini menyulitkan versioning, tidak konsisten antar provider (OpenAI vs Grok), dan memaksa frontend mengambil seluruh prompt sekaligus. Prompt Service Worker menyediakan endpoint terstruktur (JSON) sehingga:

1. UI cukup memanggil endpoint saat tab/modal benar-benar dibuka (hemat biaya API model).
2. Format JSON memastikan elemen penting (tujuan, langkah analisis, confidence guidance) konsisten antar provider.
3. Perubahan prompt cukup dilakukan lewat code/KV update pada Worker, tidak perlu patch file R2.

---

## 2. Endpoint

| Method | Path | Deskripsi | Response |
|--------|------|-----------|----------|
| `GET` | `/prompts/ai-analytics` | Mengembalikan konfigurasi prompt AI Analytics untuk semua provider | JSON (lihat struktur di bawah) |

> **Note**: Endpoint didesain cache-friendly (`Cache-Control: public, max-age=300`) agar Cloudflare edge cache menangani sebagian besar hit.

### 2.1 Query Parameters

| Param | Optional | Deskripsi |
|-------|----------|-----------|
| `provider` | Ya | Jika diisi (`openai`, `grok`), hanya mengembalikan blok provider tersebut. Default: seluruh provider. |

---

## 3. JSON Structure

```json
{
  "version": "2024-03-18",
  "prompt": {
    "overview": "Narasi ringkas tugas AI",
    "tone": "Bahasa profesional, ringkas, Bahasa Indonesia",
    "confidence": {
      "score_range": [0, 1],
      "buckets": [
        { "min": 0.0, "max": 0.2, "label": "Very Low", "color": "#dc2626", "guidance": "Hanya informatif" },
        { "min": 0.2, "max": 0.4, "label": "Low", "color": "#f97316", "guidance": "Butuh verifikasi manual" },
        { "min": 0.4, "max": 0.7, "label": "Medium", "color": "#facc15", "guidance": "Pertimbangkan risiko" },
        { "min": 0.7, "max": 0.9, "label": "High", "color": "#22c55e", "guidance": "Direkomendasikan" },
        { "min": 0.9, "max": 1.01, "label": "Very High", "color": "#16a34a", "guidance": "Keyakinan tinggi" }
      ]
    },
    "sections": {
      "summary": "Apa yang harus disampaikan di headline",
      "analysis_steps": ["Langkah 1", "Langkah 2"],
      "risks": ["Faktor risiko yang perlu diperhatikan"],
      "recommendation": {
        "fields": [
          { "key": "position", "label": "Posisi", "options": ["Buy", "Sell", "Hold"] },
          { "key": "confidence", "label": "Confidence Score", "type": "float" },
          { "key": "rationale", "label": "Alasan", "type": "string" }
        ]
      }
    },
    "providers": {
      "openai": {
        "model": "gpt-4.1-mini",
        "system_directives": [
          "Prioritaskan narasi yang actionable",
          "Gunakan bullet jika memudahkan"
        ],
        "examples": [
          {
            "input": { "ticker": "BBRI", "context": "Accumulation kuat" },
            "output": {
              "summary": "BBRI menampilkan akumulasi asing kuat...",
              "confidence": 0.78,
              "steps": ["Analisis delta", "Periksa state"],
              "risks": ["Volume harian menurun"]
            }
          }
        ]
      },
      "grok": {
        "model": "grok-beta",
        "system_directives": [
          "Sesuaikan bahasa agar natural",
          "Hindari menyebut 'Grok' dalam jawaban"
        ]
      }
    }
  }
}
```

- `confidence.buckets` akan dipakai UI untuk menentukan warna/label badge.
- `providers.*.system_directives` disuntikkan sebagai *system prompt* spesifik provider.
- `sections` dipetakan UI menjadi panel-panel narasi tanpa memaksa model menulis HTML.

---

## 4. Frontend Integration

1. Saat modal AI Analytics dibuka, jangan fetch prompt dulu.
2. Saat user klik tab provider (OpenAI / Grok), cek cache (`promptCache[provider]`). Jika kosong, fetch `/prompts/ai-analytics?provider={name}`.
3. UI membangun narasi dari JSON (bukan menampilkan JSON mentah).
4. Saat mengirim request ke model:
   - Format prompt mengacu `overview + sections + system_directives`.
   - Confidence level direspons model harus dipetakan ke bucket untuk pewarnaan UI.

Pseudo:

```js
const promptCache = {};
async function loadPrompt(provider) {
  if (promptCache[provider]) return promptCache[provider];
  const url = `/prompts/ai-analytics?provider=${provider}`;
  const res = await fetch(url, { cache: 'force-cache' });
  const json = await res.json();
  promptCache[provider] = json;
  return json;
}
```

---

## 5. Implementation Notes

- Worker dibangun memakai Wrangler (module syntax). Endpoint default `GET` return JSON dengan header `Content-Type: application/json`. Tambahkan `Cache-Control: public, max-age=300`.
- Template JSON disimpan sebagai `const PROMPTS = {...}` di dalam Worker (bisa diekstrak ke file terpisah atau KV jika butuh dynamic update).
- Pastikan Worker diekspor di `wrangler.toml` (atau gunakan pattern `prompt-service/src/index.ts`).

---

## 6. Next Steps

1. Implementasikan Worker (`workers/prompt-service/`).
2. Update frontend (`idx/emiten/broker-summary.js`) untuk lazy-load prompt saat tab provider diklik.
3. Tambahkan mapping confidence → badge di UI.
4. Migrasikan request OpenAI/Grok agar menggunakan struktur baru.

> Setelah Worker active, prompt file lama (`workers/prompt/*.txt`) bisa didepresiasi secara bertahap.
