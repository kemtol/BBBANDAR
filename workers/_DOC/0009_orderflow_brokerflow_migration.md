# Brokerflow + Orderflow — Soft Migration Plan

## 0. Goals
- Satukan konteks **recent (T0 intraday)** dari Orderflow dengan **brokerflow H-1** di broker-summary.
- Default view broker-summary menampilkan chart berbasis Orderflow; Foreign Flow tetap ada sebagai tab (toggle).
- Tabel broker-summary tetap sumber utama; filter tabel harus menyetir bubble chart (hanya quadrant yang lolos filter).
- Orderflow page/endpoint lama tidak diubah; hanya disembunyikan (soft migration) sampai validasi selesai.

## 1. Scope & Non-Goals
- Scope: backend `api-saham` agregasi data, payload broker-summary diperluas, UI broker-summary tab/chart/table sinkron.
- Non-goal: menghapus endpoint Orderflow lama, mengubah scoring/indikator Orderflow, atau merombak pipeline R2/D1.

## 2. Data Sources & Recency
- **Brokerflow (H-1)**: tabel D1 (daily broker summary) yang dipakai broker-summary saat ini.
- **Orderflow (T0 intraday)**: agregasi `temp_footprint_consolidate` (atau fallback R2 intraday) dengan konteks `daily_features` (H-1) untuk z-score/state.
- **Join key**: `ticker` uppercase. Orderflow selalu dianggap “today” (session berjalan) sehingga melengkapi brokerflow H-1 untuk konteks terbaru.

## 3. API Design (Backend `workers/api-saham/src/index.js`)
### 3.1 Response Shape (proposal)
Extend response broker-summary (existing fields dipertahankan) dengan blok `orderflow` & bubble feed:
```json
{
  "generated_at": "2026-02-14T04:05:00Z",
  "items": [
    {
      "ticker": "BBRI",
      "...": "... existing brokerflow fields ...",
      "orderflow": {
        "price": 5200,
        "delta_pct": 18.2,
        "cvd": 8.4,
        "absorb": 12.5,
        "mom_pct": 6.1,
        "net_value": 1.24e11,
        "quadrant": "Q1",            // untuk bubble
        "snapshot_at": "2026-02-14T04:04:00Z"
      }
    }
  ],
  "bubble": {
    "orderflow": [ { "ticker": "...", "x": "delta_pct", "y": "mom_pct", "r": "net_value", "q": "quadrant" } ],
    "foreign":   [ { "ticker": "...", "x": "flow20d", "y": "eff20d", "r": "mcap" } ]  // existing
  }
}
```
- Jika Orderflow tidak tersedia (market closed / ticker illiquid), `orderflow` = `null`; tetap kirim foreign bubble normal.

### 3.2 Aggregation Logic
- **Orderflow aggregation (today)**:
  - Range: 09:00 WIB → now (or last candle) on today.
  - Metrics: `deltaPct`, `pricePct`, `cvd`, `absorb`, `momPct`, `netValue` (cum value), quadrant mapping mengikuti UI orderflow saat ini.
  - Context: `daily_features` (H-1) untuk state/z_ngr jika dibutuhkan quadrant/scoring.
- **Brokerflow (H-1)**: gunakan existing query / cache yang sekarang dipakai broker-summary; tidak diubah.
- **Merge**: left-join brokerflow rows dengan map orderflow by ticker. Untuk ticker yang hanya muncul di orderflow (tidak ada di brokerflow), opsi: (a) drop, atau (b) append dengan flag `source="orderflow-only"`; default pilih (a) demi konsistensi tampilan broker-summary.

### 3.3 Endpoints & Flags
- Tambah query `include_orderflow=true` (default true) agar bisa rollback cepat.
- Tambah query `chart_tab=foreign|orderflow`? Tidak wajib; UI pilih default orderflow.

## 4. Frontend Changes (broker-summary.html)
- **Tabs** di area chart: `Order Flow` (default) | `Foreign Flow`. Tab switch hanya ganti dataset + legend.
- **Chart default**: bubble orderflow (X=delta_pct, Y=mom_pct, R=net_value; quadrant color same as orderflow page).
- **Table**: tambah kolom orderflow (minimal `Δ Harga`, `Moment %`, `Absorb`, `CVD`, `Value (cum)`) di baris broker summary; data berasal dari `orderflow` blok.
- **Filter coupling**: filter & search di tabel mem-filter dataset bubble orderflow; gunakan same predicate pipeline yang sudah ada untuk table rows.
- **Hide old Orderflow tab**: sembunyikan link/tab lama; jangan hapus scriptnya (soft migration).

## 5. Migration Steps
1) Backend
   - Implement aggregation orderflow (today) + map by ticker.
   - Extend broker-summary endpoint to attach `orderflow` block + bubble.orderflow array; protect with `include_orderflow`.
2) Frontend
   - Add chart tabs & default to Order Flow.
   - Bind chart data to `bubble.orderflow`; keep foreign as secondary dataset.
   - Add orderflow columns in table; handle null gracefully (show `-`).
   - Wire filters to re-render bubble data (Order Flow tab only).
3) Soft rollout
   - Stage with `include_orderflow=false` (control) vs true (treatment) for quick rollback.
   - Keep legacy Orderflow page hidden via CSS/DOM toggle only.

## 6. Testing Plan
- **Unit (backend)**: map join correctness (tickers overlap, missing orderflow, missing brokerflow), time-window bounds (09:00–16:00 WIB), flag `include_orderflow`.
- **Integration (backend)**: call broker-summary with/without flag; verify payload shape, null-handling, performance (<300ms for top 200 tickers).
- **Frontend manual**:
  - Load broker-summary: default tab Order Flow, chart populated.
  - Apply filters/search/sort → bubble set matches visible rows.
  - Switch to Foreign tab → shows previous foreign chart unchanged.
  - Mobile viewport: tabs & table horizontal scroll still OK.
- **Data freshness**: during market hours compare orderflow metrics vs legacy orderflow page for 3 random tickers; ensure within 1 candle delay.

## 7. Risks & Mitigations
- **Recency mismatch** (orderflow live vs brokerflow H-1): show `snapshot_at` in tooltip; allow toggle flag to disable orderflow if stale.
- **Missing intraday data**: fall back to brokerflow-only; bubble/orderflow null handled in UI.
- **Performance**: avoid N+1 by batch fetching orderflow; cache latest orderflow map for N minutes while market open.

## 8. Rollout Checklist
- Feature flag `include_orderflow` default ON in staging, OFF in prod until validated.
- Dashboard Sentry/Logging: log counts for `orderflow null` per response.
- On-call note: rollback = set flag false (no deploy needed).
