# Claude Score — Batch AI-Powered Screener Scoring

## 1. Tujuan & Ruang Lingkup

Menambahkan kolom **Claude Score (CS)** ke tabel screener yang memberikan **AI-powered probability score** untuk setiap emiten berdasarkan analisis cross-sectional terhadap seluruh universe (~700 emiten) dalam satu batch request.

Fitur ini:
- Berjalan pada **screener/scanner** (tabel dengan ~700 filtered candidates).
- Satu klik Claude logo → batch POST JSON (700 candidates) ke `/ai/claude-score` endpoint.
- Claude API score semua 700 emiten sekaligus (cross-sectional context).
- Menampilkan skor **0–100** per emiten (probability proxy, normalized terhadap universe).
- Dapat disort dan disaring seperti TOM2%/SWG5%.
- Gated: tombol Claude logo perlu diklik untuk reveal & scoring (persiapan untuk paywall).
- Efficient: 1 API call untuk 700 emiten, bukan 700 calls.

## 2. Komponen Sistem

| Komponen | Fungsi | Catatan |
|---|---|---|
| **Frontend: Claude Score Column** | Menampilkan CS di tabel screener, setelah SWG5. | Awalnya locked (`—`); unlock dengan klik logo. |
| **Frontend: Claude Logo Button** | Tombol trigger di atas header kolom CS, absolutely positioned. | Hover effect glow (orange), loading spinner saat scoring. Manual trigger (click). |
| **Frontend: Batch Data Collector** | Kumpulkan semua filtered candidates + scoring-relevant fields. | POST JSON payload ke endpoint scoring. |
| **Backend: `/ai/claude-score` Endpoint** | Terima batch data, panggil Claude API, return per-emiten scores. | Validasi JSON response, retry jika parsing gagal. |
| **Claude API** | Model LLM (claude-3-5-sonnet) yang mensintesis scoring. | Menerima prompt + dataset JSON, return structured scores. |
| **R2 Storage (Artifact)** | Simpan request + response JSON ke R2 untuk audit trail. | Key: `ai-screener-cache/{YYYY-MM-DD}/{HHmmss}_{universe_size}.json`, TTL: 15 min. |
| **Session Cache (localStorage)** | Cache skor untuk session (TTL ~30 menit). | Jika data screener berubah, invalidate cache. |

## 3. Alur Kerja End-to-End

1. **User membuka screener**, tabel muncul dengan ~700 filtered candidates dan kolom CS bernilai `—` (locked/unscored).

2. **User klik Claude logo** di atas header kolom CS.
   - Frontend menampilkan spinner pada tombol.
   - Tombol disabled selama scoring.

3. **Frontend: Batch Data Collector**
   - Kumpulkan **semua** `currentCandidates` yang terfilter saat itu (~700 emiten).
   - Untuk setiap candidate, ekstrak fields scoring-relevant:
     - Identifier: `symbol` (uppercase)
     - Smart Money cumulative: `sm2, sm5, sm10, sm20` (dalam juta)
     - Flow score: `flow2, flow5, flow10, flow20` (composite metric)
     - Effort z-score: `effort2, effort5, effort10, effort20` (z-score values)
     - VWAP z-score: `vwap5, vwap10` (z-score values, dapat null)
     - NGR z-score: `ngr5, ngr10` (z-score values, dapat null)
     - Orderflow intraday: `order_delta_pct, order_mom_pct, order_absorb, order_cvd, order_net_value` (bisa null)
     - State: `state` (ACCUMULATION / READY_MARKUP / TRANSITION / DISTRIBUTION / NEUTRAL)
     - Trend: `trend.vwapUp, trend.effortUp, trend.ngrUp` (boolean flags)
   
   - Susun payload JSON dengan semua ~700 candidates:
     ```json
     {
       "timestamp": "2025-03-01T10:30:00Z",
       "universe_size": 687,
       "filter_state": {
         "foreign": "any",
         "smart": "any",
         "state": "any"
       },
       "candidates": [
         {
           "symbol": "BBRI",
           "sm": [10000, 15000, 20000, 25000],
           "flow": [5.2, 6.1, 7.2, 8.0],
           "effort": [0.8, 1.2, 1.5, 1.8],
           "vwap": [0.5, 0.7],
           "ngr": [0.6, 0.9],
           "orderflow": {
             "delta_pct": 65,
             "mom_pct": 55,
             "absorb": 12.5,
             "cvd": 850000,
             "net_value": 1200000
           },
           "state": "ACCUMULATION",
           "trend": { "vwapUp": true, "effortUp": true, "ngrUp": false }
         },
         {
           "symbol": "TLKM",
           "sm": [5000, 8000, 12000, 18000],
           "flow": [3.1, 4.2, 5.5, 7.0],
           "effort": [0.3, 0.6, 0.9, 1.2],
           "vwap": [0.2, 0.4],
           "ngr": [0.1, 0.3],
           "orderflow": {
             "delta_pct": 42,
             "mom_pct": 38,
             "absorb": 8.2,
             "cvd": 520000,
             "net_value": 800000
           },
           "state": "READY_MARKUP",
           "trend": { "vwapUp": true, "effortUp": false, "ngrUp": true }
         },
         { ... 685 more candidates ... }
       ]
     }
     ```

4. **Frontend: POST to Scoring Endpoint**
   - Endpoint: `POST ${WORKER_BASE_URL}/ai/claude-score`
   - Headers: `Content-Type: application/json`
   - Body: JSON payload dengan 687 candidates (dari contoh di atas)
   - Timeout: **60 detik** (Claude API untuk 700 emiten bisa memakan waktu 20-40 detik)

5. **Backend: `/ai/claude-score` Endpoint**
   - **Terima batch payload** dengan ~700 candidates.
   - **Validasi schema**:
     - Perlu `candidates` array dengan ≥10 items, ≤1000 items.
     - Setiap candidate: required `symbol`, fields lain boleh null.
   
   - **Susun prompt untuk Claude** (optimized untuk batch 700 emiten):
     ```
     Anda adalah expert analis pasar saham Indonesia dengan specialization di orderflow & fund flow analysis.
     
     TUGAS: Score setiap emiten dalam dataset 0-100, merepresentasikan probabilitas bahwa emiten akan deliver return positif signifikan dalam 5-10 hari ke depan.
     
     METODOLOGI:
     1. CROSS-SECTIONAL CONTEXT
        - Anda diberikan 687 emiten dalam satu universe.
        - Bandingkan relative strength antar emiten, bukan nilai absolut.
        - Top 20% emiten harus mendapat score 60+, bottom 20% harus < 40.
     
     2. SIGNAL WEIGHTING
        a) Smart Money Flow (30% weight)
           - Positif konsisten: sm2 > sm5 > sm10 → bonus +20 points
           - Positif tapi declining: sm2 > sm5 > sm20 → bonus +10 points
           - Kumulatif positif (sm20 > 0) → bonus +5 points
        
        b) Effort Z-Score (25% weight)
           - effort2 > 1.0: structured buying pressure → +15 points
           - effort2 > 0.5: weak buying → +8 points
           - effort2 < 0: selling pressure → -10 points
        
        c) Orderflow Intraday (20% weight)
           - delta_pct > 60%: strong bullish delta → +12 points
           - mom_pct > 50%: momentum positive → +8 points
           - absorb > 10: buying absorption → +5 points
           - cvd > 500k: volume backing → +3 points
        
        d) State & Liquidity (15% weight)
           - state = ACCUMULATION: +10 points
           - state = READY_MARKUP: +8 points
           - state = DISTRIBUTION: -15 points (disqualify to <20)
           - net_value > 1M: good liquidity → +5 points
           - net_value < 100k: poor liquidity → -5 points (penalize execution risk)
        
        e) Trend Quality (10% weight)
           - trend.vwapUp = true: quality uptrend → +5 points
           - trend.effortUp = true: effort strengthening → +3 points
     
     3. CONSERVATIVE CAPPING
        - Score range: 5-95 (avoid extreme confidence)
        - If state = DISTRIBUTION regardless of other signals → cap to max 15
        - If net_value < 50k AND score > 50 → cap to 45 (liquidity risk)
     
     OUTPUT FORMAT (STRICTLY JSON):
     {
       "scores": {
         "BBRI": 78,
         "TLKM": 62,
         "ASII": 45,
         ... [685 more]
       },
       "summary": {
         "high_confidence": 45,
         "medium_confidence": 320,
         "low_confidence": 322
       }
     }
     
     CONSTRAINTS:
     - Return ONLY valid JSON. No markdown, no explanation text.
     - Every symbol in input must have a score in output.
     - Scores must be integer 0-100.
     
     DATASET:
     ${JSON.stringify(payload.candidates.slice(0, 50), null, 1)}... [truncated in log, full data sent] ...
     Total candidates: ${payload.candidates.length}
     ```
   
   - **Panggil Claude API**:
     - Model: `claude-3-5-sonnet-20241022` (optimal cost/quality untuk batch task)
     - Max tokens: 8000 (untuk 700 scores + summary)
   
   - **Validasi response JSON**:
     - Parse `response.content[0].text` sebagai JSON.
     - Validasi struktur: `scores` object dengan symbol→number mapping.
     - Setiap candidate dalam input harus ada score di output.
     - Jika parsing/validasi gagal:
       1. **Retry sekali** dengan prompt koreksi: "Output Anda bukan JSON valid. Ulangi dalam format yang tepat: { "scores": { SYMBOL: number, ... } }"
       2. Jika masih gagal → return error 400: `{ ok: false, error: "Scoring failed: AI returned invalid JSON after retry" }`
   
   - **Response sukses**:
     ```json
     {
       "ok": true,
       "scores": {
         "BBRI": 78,
         "TLKM": 62,
         "ASII": 45,
         ... [687 scores total]
       },
       "summary": {
         "high_confidence": 45,
         "medium_confidence": 320,
         "low_confidence": 322
       },
       "generated_at": "2025-03-01T10:30:15Z",
       "model": "claude-3-5-sonnet-20241022",
       "usage": {
         "input_tokens": 12500,
         "output_tokens": 2800
       }
     }
     ```

6. **Frontend: Populate Scores**
   - Response sukses → iterate `scores` object dari response.
   - Set `item.claude_score = scores[symbol]` untuk **setiap candidate dalam currentCandidates** (semua 687 emiten).
   - Call `updateVisibleClaudeCells()` → batch-update semua DOM cells di tabel dengan warna & angka score.
   - Update sort icon di header CS (sekarang sortable).
   - Cache scores di `localStorage` dengan key:
     ```javascript
     const cacheKey = `claude_scores_${btoa(JSON.stringify(filterState))}_${new Date().toISOString().split('T')[0]}`;
     localStorage.setItem(cacheKey, JSON.stringify({ scores, timestamp: Date.now(), universe_size: 687 }));
     ```
     TTL: ~30 menit (atau sampai filter berubah).
   - Re-enable Claude logo button, hilangkan spinner, show success toast: "✓ Claude scored 687 emiten".

7. **User dapat sort/filter** berdasarkan Claude Score.
   - Click header CS → sort ascending/descending (seperti TOM2, SWG5).
   - (Opsi) Tambah numeric filter `claude_min` ke filter dropdown (e.g., "Score ≥ 60").
   - Scores persist across page navigation (cached di localStorage).

## 4. UI Components & Styling

### 4.1 Claude Score Column Header (`<th>`)

```html
<th class="text-center claude-score-header" data-sort="claude_score" 
    style="cursor:pointer; white-space:nowrap; position: relative;">
    <button type="button" class="claude-trigger-btn" 
        id="btn-claude-score" 
        title="Click to generate AI scores for all visible emiten"
        style="position: absolute; top: -22px; left: 50%; transform: translateX(-50%); 
               border: none; background: none; padding: 0; cursor: pointer; z-index: 10;">
        <!-- Claude Logo SVG (starburst, orange) -->
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- Simplified Claude starburst: orange rays emanating from center -->
            <circle cx="12" cy="12" r="4" fill="#ff9500"/>
            <path d="M12 2 L12 6 M12 18 L12 22 M2 12 L6 12 M18 12 L22 12" stroke="#ff9500" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M4.5 4.5 L7 7 M17 17 L19.5 19.5 M4.5 19.5 L7 17 M17 7 L19.5 4.5" stroke="#ff9500" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
    </button>
    CS <i class="fa-solid fa-sort small text-muted"></i>
</th>
```

### 4.2 Claude Score Cell (`<td>`)

```html
<td class="text-center claude-cell" data-symbol="BBRI">
    <span class="claude-score-badge">—</span>
    <!-- Will be updated to: <span class="claude-score-badge text-success fw-bold">78</span> -->
</td>
```

### 4.3 CSS Styling

```css
.claude-trigger-btn {
    opacity: 0.7;
    transition: opacity 0.2s, filter 0.2s;
}

.claude-trigger-btn:hover:not(:disabled) {
    opacity: 1;
    filter: drop-shadow(0 0 6px rgba(255, 149, 0, 0.6));
}

.claude-trigger-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.claude-trigger-btn.loading svg {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.claude-score-badge {
    font-weight: 500;
    transition: color 0.15s;
}

.claude-score-badge.locked {
    color: var(--text-muted);
}

.claude-score-badge.text-success {
    color: var(--accent-positive); /* ≥70 */
}

.claude-score-badge.text-primary {
    color: var(--accent-primary); /* 50-69 */
}

.claude-score-badge.text-warning {
    color: var(--accent-warning); /* 35-49 */
}

.claude-score-badge.text-muted {
    color: var(--text-muted); /* <35 */
}
```

### 4.4 Color Thresholds

| Score | Color | Meaning |
|-------|-------|---------|
| ≥70 | Success (Green) | HIGH confidence |
| 50-69 | Primary (Blue) | MEDIUM confidence |
| 35-49 | Warning (Orange) | LOW confidence |
| <35 | Muted (Gray) | VERY LOW confidence |
| — | Muted (Gray) | Locked / not scored |

## 5. Frontend Implementation Checklist

### Data Model
- [ ] Add `claude_score` property to candidate object (initialize `null`).
- [ ] Add `claude_score` numeric sort key to `sortCandidates()` function.
- [ ] Implement `fmtClaudeCell(score)` formatter (returns HTML badge with color).
- [ ] Implement `updateClaudeCells(symbol, item)` to update single row.
- [ ] Implement `updateVisibleClaudeCells()` to batch-update all visible rows.

### UI Components
- [ ] Add Claude Score `<th>` with logo button to screener table header.
- [ ] Add Claude Score `<td>` cells to row template in `renderScreenerTable()`.
- [ ] Add CSS for `.claude-trigger-btn`, `.claude-score-badge`, and spinner animation.
- [ ] Ensure dark theme compatibility for Claude logo (orange on dark bg).

### Event Handlers
- [ ] Click handler on `#btn-claude-score` button.
- [ ] Validate filtered candidates count (warn if <3 candidates).
- [ ] Show loading spinner (add `.loading` class to button).
- [ ] Disable button during scoring.

### Batch Data Collector
- [ ] Function `collectClaudeScoringData()` → returns payload JSON.
- [ ] Include all scoring-relevant fields (sm, flow, effort, vwap, ngr, orderflow, state, trend).
- [ ] Add timestamp & universe_size to metadata.

### API Call & Response Handling
- [ ] POST to `/ai/claude-score` with 60-second timeout.
- [ ] Handle success response: iterate scores, set `item.claude_score`.
- [ ] Call `updateVisibleClaudeCells()` to render new scores.
- [ ] Cache scores in localStorage with TTL ~30 min.
- [ ] Handle error responses: show toast/alert with error message.
- [ ] Handle network timeout: show user-friendly message.

### Session Cache
- [ ] Implement `saveClaudeScores(filterStateHash, scores, ttl)`.
- [ ] Implement `loadClaudeScores(filterStateHash)` → check TTL.
- [ ] Invalidate cache when filter changes (detected via filter change handlers).

## 6. Backend Implementation Checklist

### Endpoint: `POST /ai/claude-score`

**Request Schema (Batch):**
```typescript
{
  timestamp: string;              // ISO 8601, when batch was collected
  universe_size: number;          // Total candidates sent (e.g., 687)
  filter_state: {                 // For cache invalidation on frontend
    [key: string]: string;        // e.g., { foreign: "any", smart: "any", state: "any" }
  };
  candidates: Array<{
    symbol: string;               // Uppercase (e.g., "BBRI")
    sm: [number, number, number, number];       // [sm2, sm5, sm10, sm20] in million, can be negative
    flow: [number, number, number, number];     // [flow2, flow5, flow10, flow20] composite scores
    effort: [number, number, number, number];   // [eff2, eff5, eff10, eff20] z-scores, can be null
    vwap: [number | null, number | null];       // [vwap5, vwap10] z-scores
    ngr: [number | null, number | null];        // [ngr5, ngr10] z-scores
    orderflow: {
      delta_pct: number | null;   // Intraday delta % (0-100)
      mom_pct: number | null;     // Intraday momentum % (0-100)
      absorb: number | null;      // Absorption score
      cvd: number | null;         // CVD (cumulative volume delta)
      net_value: number | null;   // Net order value
    };
    state: string;                // ACCUMULATION | READY_MARKUP | TRANSITION | DISTRIBUTION | NEUTRAL
    trend: {
      vwapUp: boolean;            // VWAP 2D > 5D > 10D > 20D
      effortUp: boolean;          // Effort 2D ≥ 5D ≥ 10D ≥ 20D
      ngrUp: boolean;             // NGR 2D ≥ 5D ≥ 10D ≥ 20D
    };
  }>;  // Array length: 10-1000 (typically ~700)
}
```

**Response Schema (Success — 200 OK):**
```typescript
{
  ok: true;
  scores: {
    [symbol: string]: number;     // e.g., { "BBRI": 78, "TLKM": 62, ... }
  };                              // Every input symbol has a score 0-100
  summary: {
    high_confidence: number;      // Count of scores ≥ 70
    medium_confidence: number;    // Count of scores 50-69
    low_confidence: number;       // Count of scores < 50
  };
  generated_at: string;           // ISO 8601 timestamp when scoring completed
  model: string;                  // "claude-3-5-sonnet-20241022"
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
```

**Response Schema (Error):**
```json
{
  "ok": false,
  "error": "string description",
  "status": 400 | 429 | 500
}
```

**Error Cases:**
- `400`: Invalid request schema (missing fields, invalid candidates array size)
- `429`: Rate limited (Claude API quota exceeded)
- `500`: Internal error (JSON parse failure after retry, worker failure)

### Implementation Steps
- [ ] Add route handler for `POST /ai/claude-score`.
- [ ] Validate request schema (candidates array, required fields).
- [ ] **Check R2 cache first** (`ai-screener-cache/{DATE}/latest.json`): if exists & fresh (<15 min) → return cached response without calling Claude.
- [ ] Ensure ANTHROPIC_API_KEY environment variable exists.
- [ ] Build Claude prompt (see Section 3, step 5).
- [ ] Call Claude API via fetch/SDK.
- [ ] Parse response.content[0].text as JSON.
- [ ] Implement retry logic: if parse fails, retry once with correction prompt.
- [ ] **Save artifact to R2**: `sssaham-emiten/ai-screener-cache/{DATE}/{HHmmss}_{universe_size}.json` with TTL metadata.
- [ ] **Update latest pointer**: overwrite `ai-screener-cache/{DATE}/latest.json` (same content, for cache lookup).
- [ ] Log success/failure: symbol count, model, token usage, R2 key.
- [ ] Return JSON response.

## 7. Data Flow Diagram

```
┌─ Screener Table with ~700 Filtered Candidates
│  (columns: Emiten, Growth, TOM2%, SWG5%, [CS←locked], ..., State, Value, Q)
│
└─→ User clicks Claude Logo Button (above "CS" header)
    │
    ├─→ Frontend: showSpinner() + disable button
    │
    ├─→ Frontend: collectClaudeScoringData()
    │   └─→ Extract all 687 candidates' scoring fields
    │   └─→ Returns JSON payload:
    │       {
    │         timestamp: "2025-03-01T10:30:00Z",
    │         universe_size: 687,
    │         filter_state: { foreign: "any", smart: "any", ... },
    │         candidates: [
    │           { symbol: "BBRI", sm: [10k, 15k, 20k, 25k], flow: [...], ... },
    │           { symbol: "TLKM", sm: [5k, 8k, 12k, 18k], flow: [...], ... },
    │           ... [685 more] ...
    │         ]
    │       }
    │
    ├─→ POST /ai/claude-score (timeout: 60s)
    │   │
    │   └─→ Backend:
    │       ├─ Validate payload (candidates count 10-1000 OK, schema valid)
    │       ├─ Check R2 cache: ai-screener-cache/{DATE}/latest.json
    │       │   ├─ If exists & age < 15 min → return cached (skip Claude API call)
    │       │   └─ If missing or stale → proceed to Claude API
    │       ├─ Build Claude prompt with cross-sectional context
    │       ├─ Call Claude API (claude-3-5-sonnet, max_tokens: 8000)
    │       ├─ Parse response.content[0].text as JSON
    │       ├─ Validate: every symbol has a score (0-100), all integers
    │       ├─ If parse fails → Retry once with correction prompt
    │       ├─ If retry fails → Return error 400
    │       ├─ Save artifact to R2:
    │       │   ├─ ai-screener-cache/{DATE}/{HHmmss}_{687}.json  (immutable log)
    │       │   └─ ai-screener-cache/{DATE}/latest.json          (cache pointer)
    │       └─ Return success response:
    │           {
    │             ok: true,
    │             scores: {
    │               BBRI: 78,
    │               TLKM: 62,
    │               ASII: 45,
    │               ... [687 scores]
    │             },
    │             summary: { high: 45, medium: 320, low: 322 },
    │             generated_at: "...",
    │             model: "claude-3-5-sonnet-20241022",
    │             usage: { input_tokens: 12500, output_tokens: 2800 }
    │           }
    │
    ├─→ Frontend: Populate Scores
    │   ├─ Iterate response.scores
    │   ├─ For each symbol:
    │   │   item.claude_score = scores[symbol]
    │   │   item.claude_score_prob = scores[symbol] (for sorting)
    │   ├─ Call updateVisibleClaudeCells() to batch-render all ~700 DOM cells
    │   │   (each cell gets colored badge: green if ≥70, blue if 50-69, orange if 35-49, gray if <35)
    │   ├─ Cache in localStorage:
    │   │   Key: claude_scores_${hash(filterState)}_${today}
    │   │   Value: { scores, timestamp, universe_size }
    │   │   TTL: 30 min (or on filter change, invalidate)
    │   ├─ Re-enable button, hide spinner
    │   └─ Show toast: "✓ Claude scored 687 emiten (45 high, 320 med, 322 low)"
    │
    ├─→ User can now:
    │   ├─ Click "CS" header → sort by Claude Score ↑↓
    │   ├─ (Future) Add numeric filter "Score ≥ 60"
    │   └─ Refresh page → scores still cached (if <30 min old & same filter)
    │
    └─→ Scores persist in currentCandidates.claude_score for session
```

## 8. Gating & Paywall (Future)

**Phase 1 (Current):** Simple reveal button. Anyone can click.

**Phase 2 (Future):** Session-level gating.
- User clicks button → check `localStorage` for `claude_session_token` (set on login).
- If not found → show modal "upgrade to unlock Claude Score" with subscription CTA.
- If found → proceed with scoring.

**Phase 3 (Optional):** Rate limiting.
- Log API calls per user per day.
- If >10 calls/day → show "daily limit reached" message.

## 9. Prompt Strategy

The Claude prompt emphasizes:
1. **Cross-sectional ranking** (relative to other emiten in universe).
2. **Multi-signal synthesis**: SM flow + effort + orderflow consistency.
3. **State-based modulation**: ACCUMULATION/READY_MARKUP bonus, DISTRIBUTION penalty.
4. **Risk-awareness**: likuiditas matters; jangan reward saham sepi.
5. **Conservative scoring**: 0-100 range, most scores 30-75 (avoid extreme confidence).

The prompt is crafted to **minimize overfitting** and **maximize cross-session robustness** (scores should be relatively stable across different screener filters, as long as core data is unchanged).

## 10. Caching & Artifact Storage Strategy

### 10.1 R2 Artifact Storage (Backend)

Setiap scoring disimpan sebagai artifact di R2 bucket `sssaham-emiten` untuk audit trail dan caching.

**R2 Key Convention:**
```
sssaham-emiten/
└── ai-screener-cache/
    └── 2025-03-01/
        ├── latest.json                    ← Cache pointer (overwritten setiap scoring)
        ├── 103015_687.json                ← Immutable artifact (HHmmss_universeSize)
        ├── 113522_342.json                ← Another scoring with different filter
        └── 144801_687.json                ← Re-score after data refresh
```

**Artifact JSON Structure:**
```json
{
  "ok": true,
  "scores": { "BBRI": 78, "TLKM": 62, ... },
  "summary": { "high_confidence": 45, "medium_confidence": 320, "low_confidence": 322 },
  "generated_at": "2025-03-01T10:30:15Z",
  "model": "claude-3-5-sonnet-20241022",
  "usage": { "input_tokens": 12500, "output_tokens": 2800 },
  "request_metadata": {
    "universe_size": 687,
    "filter_state": { "foreign": "any", "smart": "any" },
    "request_timestamp": "2025-03-01T10:30:00Z"
  }
}
```

**R2 Custom Metadata:**
```json
{
  "generated_at": "2025-03-01T10:30:15Z",
  "universe_size": "687",
  "model": "claude-3-5-sonnet-20241022",
  "ttl_minutes": "15"
}
```

**Backend Cache Flow:**
1. Request masuk → check `ai-screener-cache/{DATE}/latest.json` di R2.
2. Jika `latest.json` ada DAN `generated_at` < 15 menit lalu → return cached JSON langsung (skip Claude API call).
3. Jika tidak ada atau stale → panggil Claude API → simpan ke R2 (2 writes: immutable + latest).
4. Response sama persis baik dari cache maupun fresh (client tidak perlu tahu).

### 10.2 Cache TTL Summary

| Where | Key | TTL | Invalidation | Purpose |
|-------|-----|-----|--------------|--------|
| **R2 (backend)** | `ai-screener-cache/{DATE}/latest.json` | **15 min** | Overwritten on new scoring | Avoid duplicate Claude API calls, hemat biaya |
| **R2 (backend)** | `ai-screener-cache/{DATE}/{HHmmss}_{n}.json` | **7 hari** | Cron housekeeping | Immutable audit trail / history |
| **localStorage (frontend)** | `claude_scores_${hash}` | **30 min** | Filter change, or TTL expire | Avoid duplicate POST requests |

### 10.3 Cost Optimization

Dengan TTL 15 menit di R2:
- Multiple user klik dalam 15 menit → hanya 1 Claude API call.
- Estimasi: max **4 calls/jam** (jika terus-menerus diklik), realistically **2-3 calls/jam** saat trading hours.
- Biaya Claude API per call (~700 emiten): ~12.5K input tokens + ~2.8K output tokens ≈ $0.05/call.
- **Max daily cost estimate**: 4 × 7 hours × $0.05 ≈ **$1.40/hari**.

### 10.4 Housekeeping

- **Cron harian** (e.g., `0 20 * * *` WIB, setelah market close):
  - List `ai-screener-cache/` prefix.
  - Delete folders older than 7 days.
  - Log: jumlah artifacts deleted, total size freed.

## 11. Error Handling & Resilience

| Scenario | Action |
|----------|--------|
| <3 candidates filtered | Warn user "too few emiten to score meaningfully" |
| R2 cache hit (< 15 min old) | Return cached response immediately, skip Claude API |
| R2 cache miss / stale | Proceed to Claude API call |
| R2 write failure | Log error, still return scores to frontend (cache miss on next call) |
| Claude API timeout (>60s) | Show error "scoring took too long, please retry" |
| JSON parse fail (1st attempt) | Retry with correction prompt |
| JSON parse fail (2nd attempt) | Return 500 error: "AI returned invalid response" |
| ANTHROPIC_API_KEY missing | Return 500 error at startup (caught by worker boot) |
| Network error | Retry once, then show user-friendly error |

## 12. Roadmap & Future Enhancements

- **Phase 2**: Explain scores with reasoning (return `{ scores, reasoning: { SYMBOL: "..." } }`).
- **Phase 3**: Per-emiten score history (track how score evolved daily).
- **Phase 4**: Custom scoring rules (user can weight factors: prefer high SM over high effort, etc.).
- **Phase 5**: Integration with AI Broker Summary (use Claude Score as input signal).
- **Phase 6**: A/B testing: compare Claude Score vs. TOM2/SWG5 predictive power.

---

## Implementation Order

### Phase 1: Frontend Foundation (2-3 hours)
1. **UI Components**
   - Add Claude Score `<th>` with logo button to `broker-summary.html`
   - Add Claude Score `<td>` cells to row template
   - CSS: button styling, spinner animation, score badge colors
   
2. **Data Model & Helpers**
   - Add `claude_score` property to candidate object (initialize `null`)
   - Implement `fmtClaudeCell(score)` formatter (0-100 with colors)
   - Implement `updateClaudeCells(symbol, item)` for single row
   - Implement `updateVisibleClaudeCells()` for batch DOM update
   - Add `claude_score` sort key to `sortCandidates()` function

3. **Event Handlers & Batch Collection**
   - Click handler on `#btn-claude-score` button
   - Implement `collectClaudeScoringData()` → returns JSON payload (700 candidates)
   - Show loading spinner, disable button

### Phase 2: Frontend API Integration (2-3 hours)
4. **API Call & Response Handling**
   - POST to `/ai/claude-score` with 60s timeout
   - Handle success response: parse JSON, populate scores
   - Update DOM with `updateVisibleClaudeCells()`
   - Handle error responses: toast/alert with user-friendly messages
   - Handle network timeout

5. **Session Cache (localStorage)**
   - Implement `saveClaudeScores(filterStateHash, scores)` with TTL 30 min
   - Implement `loadClaudeScores(filterStateHash)` → check TTL & validity
   - Invalidate cache on filter change (detect via filter event handler)
   - On page load: check cache, pre-populate if valid

### Phase 3: Backend Endpoint (4-5 hours)
6. **Endpoint Skeleton & Validation**
   - Add route handler for `POST /ai/claude-score` in `workers/api-saham/src/index.js`
   - Validate request schema (candidates array 10-1000, required fields)
   - Return 400 on invalid payload

7. **Claude API Integration**
   - Ensure `ANTHROPIC_API_KEY` environment variable exists
   - Build Claude prompt (from Section 5 of this doc)
   - Call Claude API with full batch payload
   - Handle API errors: timeout, rate limit (429), invalid key (401)

8. **JSON Response Validation & Retry**
   - Parse `response.content[0].text` as JSON
   - Validate structure: `scores` object with symbol→number mapping
   - Verify every input symbol has a score in output
   - If parse fails: retry once with correction prompt
   - If retry fails: return 500 error with "Invalid AI response"

9. **Logging & Monitoring**
   - Log success: model, tokens used, universe_size, processing time
   - Log errors: reason (validation fail, API error, JSON parse fail), retry attempts
   - Include request ID for tracing

### Phase 4: Testing & Deployment (3-4 hours)
10. **Unit & Integration Tests**
    - Test `fmtClaudeCell()` with various scores (0, 50, 70, 100)
    - Test `collectClaudeScoringData()` with mock candidates
    - Test sorting by Claude Score
    - Test localStorage cache (set, get, expire, invalidate)
    - Mock Claude API: test JSON parse + retry logic

11. **Integration Tests**
    - End-to-end: click button → POST → populate scores → cache → sort
    - Test with different filter states (verify cache invalidation)
    - Test with 687 candidates (realistic size)
    - Test timeout handling (mock 80s API response)
    - Test 429 rate limit (mock response)

12. **Deployment**
    - Add `ANTHROPIC_API_KEY` secret to `api-saham` worker (Cloudflare dashboard or `wrangler.toml`)
    - Test in staging environment with real Claude API
    - Monitor first 24 hours for errors/rate limits
    - Verify localStorage caching works across page navigations
    - Document API limits (e.g., max 10 calls/hour per user for future paywall)

### Estimated Timeline
- **Total: 11-15 hours** (depending on testing thoroughness)
- **Frontend: 4-6 hours**
- **Backend: 4-5 hours**
- **Testing & Deployment: 3-4 hours**

### Optional Enhancements (Phase 2+)
- Add numeric filter `claude_min` to screener filters
- Explain button: hover → show methodology summary
- Score history: track scores over days (requires R2 logging)
- A/B testing: compare Claude vs TOM2/SWG5 predictive power
- Custom prompts: allow users to tune scoring weights
