Targetnya **TOM2% (besok +2%)** dan **SWG5% (swing +5% dalam ~5 hari)** 

* **jangan pakai angka ambang tetap** (mis. CVD > 500k) karena itu gampang “fit” ke periode tertentu,
* pakai **cross-sectional percentile** (ranking relatif vs seluruh universe candidates saat itu),
* pakai **gating ringan** (DISTRIBUTION / likuiditas rendah) + **komposit monotonic** (semakin besar sinyal → skor makin tinggi),
* tampilkan sebagai **probability proxy** (calibrated belakangan pakai data label).

Di bawah ini saya kasih **rekomendasi final** untuk 2 kolom itu (definisi, PRD ringkas, dan patch JS yang plug-and-play ke screener kamu).

---

## PRD ringkas: Kolom TOM2% & SWG5%

### Tujuan

Menambahkan 2 kolom di tabel screener (di samping “Emiten”):

* **TOM2%**: skor probabilitas proxy bahwa *besok* return ≥ +2% (ready to markup).
* **SWG5%**: skor probabilitas proxy bahwa dalam ~5 hari ke depan bisa mencapai +5% (swing).

### Input data yang dipakai (yang sudah kamu punya)

* Smart Money: `sm2/sm5/sm10/sm20` (atau `w2.sm` dst)
* Effort z-score: `metrics.effort2/5/10/20`
* Flow: `flow2/5/10/20`
* VWAP z: `metrics.vwap2/5/10/20` (opsional untuk SWG)
* Orderflow intraday: `order_delta_pct, order_mom_pct, order_absorb, order_cvd, order_net_value`
* State: `READY_MARKUP/ACCUMULATION/TRANSITION/DISTRIBUTION/NEUTRAL`

### Prinsip anti-overfitting

1. Semua sinyal numerik diubah jadi **percentile 0..1** di universe `currentCandidates` (setelah filter).
2. Skor komponen pakai **centered percentile**: `cp = 2*p - 1` (range -1..+1).
3. Untuk sinyal “harus bullish” (SM, MOM, Δ%, CVD), pakai **sign-gate**:

   * kalau raw ≤ 0 → `cp` tidak boleh positif (dipaksa ≤ 0).
4. Likuiditas pakai **smooth multiplier** dari percentile `order_net_value` (bukan threshold keras).
5. Output kolom adalah **probability proxy** (bisa dikalibrasi nanti).

### UX

* Angka tampil `0–90%` (cap konservatif).
* Warna:

  * ≥70 hijau, 50–69 biru, 35–49 oranye, <35 abu.
* Klik header bisa sort by TOM2% / SWG5%.

---

## Definisi skor (final)

### 1) TOM2% (besok +2%)

**Lebih berat ke sinyal paling “dekat”**:

* Smart Money (short) + Effort (short) + Orderflow intraday confirm.

Komponen (semua berbasis percentile):

* `SM_short = 0.7*cp(sm2) + 0.2*cp(sm5) + 0.1*cp(sm10)`  *(sign-gated)*
* `EFF_short = 0.7*cp(eff2) + 0.3*cp(eff5)`
* `OF = mean( cp(mom), cp(delta), cp(absorb), cp(cvd) )`
  *(mom/delta/cvd sign-gated; absorb tidak perlu gate kalau memang selalu positif)*
* `liqFactor = smooth( p(net_value) )` → memperkecil skor untuk saham sepi.

Total:

* `raw = liqFactor * (0.45*SM_short + 0.35*OF + 0.20*EFF_short + stateBonus)`
* `prob = clamp(5, 90, 5 + 85*max(0, raw))`  *(konservatif, no “overconfident” sigmoid)*

Disqualifier:

* `state === 'DISTRIBUTION'` → 5%

### 2) SWG5% (swing +5% dalam 5 hari)

**Lebih berat ke “mid-window accumulation & quality”**:

* Smart Money 5D/10D + Flow 5D/10D + Effort 5D/10D + VWAP trend/quality.

Komponen:

* `SM_swing = 0.5*cp(sm5) + 0.3*cp(sm10) + 0.2*cp(sm20)` *(sign-gated)*
* `FLOW = 0.6*cp(flow5) + 0.4*cp(flow10)`
* `EFF = 0.6*cp(eff5) + 0.4*cp(eff10)`
* `VWAP = 0.7*cp(vwap5) + 0.3*cp(vwap10)` *(opsional kalau vwap z kamu meaningful)*
* `quality = cp(ngr5)` (kalau kamu mau; kalau nggak yakin, skip)
* `trendBonus = (trend.vwapUp ? +0.05 : 0)` (opsional)

Total:

* `raw = liqFactor * (0.35*SM_swing + 0.25*FLOW + 0.20*EFF + 0.15*VWAP + 0.05*trendBonus + stateBonus)`
* `prob = clamp(5, 90, 5 + 85*max(0, raw))`

Disqualifier sama.

---

## Patch JS (percentile-based, minim tuning)

> Ini bisa kamu taruh di `broker-summary.js` (mis. dekat helper functions), lalu panggil `recomputeProbColumns(currentCandidates)` sebelum render/sort.

```js
// ─────────────────────────────────────────────────────────────
// Percentile helpers (cross-sectional; anti-overfitting)
// ─────────────────────────────────────────────────────────────
function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function buildPercentileMap(cands, getVal) {
  const arr = [];
  for (const c of cands) {
    const v = getVal(c);
    if (isNum(v)) arr.push({ s: c.symbol, v });
  }
  if (arr.length <= 1) {
    const only = arr[0]?.s;
    return only ? { [only]: 0.5 } : {};
  }
  arr.sort((a, b) => a.v - b.v);

  // rank-based percentile; stable & fast
  const out = {};
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    out[arr[i].s] = i / (n - 1);
  }
  return out;
}

function centeredPct(p) {
  // 0..1 -> -1..+1
  const cp = (p * 2) - 1;
  return Math.max(-1, Math.min(1, cp));
}

function signGate(raw, cp) {
  // untuk sinyal bullish: nilai <= 0 tidak boleh "dianggap bagus"
  if (!isNum(raw)) return 0;
  if (raw <= 0) return Math.min(0, cp);
  return cp;
}

function smoothLiq(p) {
  // smooth multiplier: 10th pct -> 0, 50th pct -> ~1
  if (!isNum(p)) return 0.5;
  const x = (p - 0.10) / 0.40;
  return Math.max(0, Math.min(1, x));
}

function clamp(min, max, x) {
  return Math.max(min, Math.min(max, x));
}

// ─────────────────────────────────────────────────────────────
// Build percentile universe for needed features
// ─────────────────────────────────────────────────────────────
function buildPercentiles(cands) {
  return {
    sm2:   buildPercentileMap(cands, c => c.sm2),
    sm5:   buildPercentileMap(cands, c => c.sm5),
    sm10:  buildPercentileMap(cands, c => c.sm10),
    sm20:  buildPercentileMap(cands, c => c.sm20),

    eff2:  buildPercentileMap(cands, c => c.metrics?.effort2),
    eff5:  buildPercentileMap(cands, c => c.metrics?.effort5),
    eff10: buildPercentileMap(cands, c => c.metrics?.effort10),

    flow5: buildPercentileMap(cands, c => c.flow5),
    flow10:buildPercentileMap(cands, c => c.flow10),

    vwap5: buildPercentileMap(cands, c => c.metrics?.vwap5),
    vwap10:buildPercentileMap(cands, c => c.metrics?.vwap10),

    ngr5:  buildPercentileMap(cands, c => c.metrics?.ngr5),

    mom:   buildPercentileMap(cands, c => c.order_mom_pct),
    delta: buildPercentileMap(cands, c => c.order_delta_pct),
    absorb:buildPercentileMap(cands, c => c.order_absorb),
    cvd:   buildPercentileMap(cands, c => c.order_cvd),
    netv:  buildPercentileMap(cands, c => c.order_net_value),
  };
}

function getP(P, key, symbol) {
  const m = P[key] || {};
  const p = m[symbol];
  return isNum(p) ? p : 0.5;
}

function stateBonus(state) {
  if (state === 'READY_MARKUP') return 0.10;
  if (state === 'ACCUMULATION') return 0.06;
  if (state === 'TRANSITION') return 0.02;
  return 0;
}

// ─────────────────────────────────────────────────────────────
// TOM2% (Tomorrow +2%) — probability proxy (percentile-based)
// ─────────────────────────────────────────────────────────────
function calcTOM2(item, P) {
  if (item.state === 'DISTRIBUTION') {
    return { prob: 5, raw: 0, label: 'DISQ' };
  }

  const s = item.symbol;

  const pNet = getP(P, 'netv', s);
  const liq = smoothLiq(pNet);

  const cpSm2  = signGate(item.sm2,  centeredPct(getP(P,'sm2',s)));
  const cpSm5  = signGate(item.sm5,  centeredPct(getP(P,'sm5',s)));
  const cpSm10 = signGate(item.sm10, centeredPct(getP(P,'sm10',s)));
  const SM = (0.7 * cpSm2) + (0.2 * cpSm5) + (0.1 * cpSm10);

  const cpEff2 = centeredPct(getP(P,'eff2',s));
  const cpEff5 = centeredPct(getP(P,'eff5',s));
  const EFF = (0.7 * cpEff2) + (0.3 * cpEff5);

  const cpMom   = signGate(item.order_mom_pct,   centeredPct(getP(P,'mom',s)));
  const cpDelta = signGate(item.order_delta_pct, centeredPct(getP(P,'delta',s)));
  const cpCvd   = signGate(item.order_cvd,       centeredPct(getP(P,'cvd',s)));
  const cpAbs   = centeredPct(getP(P,'absorb',s)); // biasanya >0 semua

  const OF = (cpMom + cpDelta + cpAbs + cpCvd) / 4;

  const raw = liq * (0.45*SM + 0.35*OF + 0.20*EFF + stateBonus(item.state));

  // conservative mapping: only positive raw contributes to probability
  const prob = clamp(5, 90, Math.round(5 + 85*Math.max(0, raw)));

  const label = prob >= 70 ? 'HIGH'
    : prob >= 50 ? 'MED'
    : prob >= 35 ? 'LOW'
    : 'VLOW';

  return { prob, raw, label };
}

// ─────────────────────────────────────────────────────────────
// SWG5% (Swing +5% in ~5D) — percentile-based
// ─────────────────────────────────────────────────────────────
function calcSWG5(item, P) {
  if (item.state === 'DISTRIBUTION') {
    return { prob: 5, raw: 0, label: 'DISQ' };
  }

  const s = item.symbol;

  const pNet = getP(P, 'netv', s);
  const liq = smoothLiq(pNet);

  const cpSm5  = signGate(item.sm5,  centeredPct(getP(P,'sm5',s)));
  const cpSm10 = signGate(item.sm10, centeredPct(getP(P,'sm10',s)));
  const cpSm20 = signGate(item.sm20, centeredPct(getP(P,'sm20',s)));
  const SM = (0.5*cpSm5) + (0.3*cpSm10) + (0.2*cpSm20);

  const cpFlow5  = centeredPct(getP(P,'flow5',s));
  const cpFlow10 = centeredPct(getP(P,'flow10',s));
  const FLOW = (0.6*cpFlow5) + (0.4*cpFlow10);

  const cpEff5  = centeredPct(getP(P,'eff5',s));
  const cpEff10 = centeredPct(getP(P,'eff10',s));
  const EFF = (0.6*cpEff5) + (0.4*cpEff10);

  const cpVwap5  = centeredPct(getP(P,'vwap5',s));
  const cpVwap10 = centeredPct(getP(P,'vwap10',s));
  const VWAP = (0.7*cpVwap5) + (0.3*cpVwap10);

  const trendBonus = item.trend?.vwapUp ? 0.05 : 0;

  const raw = liq * (0.35*SM + 0.25*FLOW + 0.20*EFF + 0.15*VWAP + trendBonus + stateBonus(item.state));

  const prob = clamp(5, 90, Math.round(5 + 85*Math.max(0, raw)));

  const label = prob >= 70 ? 'HIGH'
    : prob >= 50 ? 'MED'
    : prob >= 35 ? 'LOW'
    : 'VLOW';

  return { prob, raw, label };
}

// ─────────────────────────────────────────────────────────────
// Apply to candidates
// ─────────────────────────────────────────────────────────────
function recomputeProbColumns(cands) {
  const P = buildPercentiles(cands);
  for (const item of cands) {
    item.tom2 = calcTOM2(item, P);
    item.swg5 = calcSWG5(item, P);
    // optional: store numeric for sorting
    item.tom2_prob = item.tom2?.prob ?? 0;
    item.swg5_prob = item.swg5?.prob ?? 0;
  }
}
```

---

## Integrasi ke tabel (minimal changes)

### 1) Tambah header kolom (di HTML `<thead>`)

Taruh setelah “Emiten”:

```html
<th class="text-center" data-sort="tom2_prob" style="cursor:pointer; white-space:nowrap;">
  TOM2% <i class="fa-solid fa-sort small text-muted"></i>
</th>
<th class="text-center" data-sort="swg5_prob" style="cursor:pointer; white-space:nowrap;">
  SWG5% <i class="fa-solid fa-sort small text-muted"></i>
</th>
```

### 2) Tambah cell kolom di row template (`renderScreenerTable`)

Buat formatter:

```js
function fmtProbCell(x) {
  const p = x?.prob;
  if (!isNum(p)) return '<span class="text-muted">-</span>';
  const cls = p >= 70 ? 'text-success fw-bold'
    : p >= 50 ? 'text-primary fw-bold'
    : p >= 35 ? 'text-warning'
    : 'text-muted';
  return `<span class="${cls}">${p}%</span>`;
}
```

Lalu di row string tambahkan dua `<td>` setelah Emiten:

```js
<td class="text-center tom2-cell">${fmtProbCell(item.tom2)}</td>
<td class="text-center swg5-cell">${fmtProbCell(item.swg5)}</td>
```

### 3) Pastikan dihitung sebelum render/sort

Di `applyFilter()` sebelum `sortCandidates(...)`:

```js
recomputeProbColumns(currentCandidates);
sortCandidates(sortState.key, sortState.desc);
```

### 4) Tambah sorting key di `sortCandidates`

Tambahkan:

```js
else if (key === 'tom2_prob') { valA = a.tom2_prob || 0; valB = b.tom2_prob || 0; }
else if (key === 'swg5_prob') { valA = a.swg5_prob || 0; valB = b.swg5_prob || 0; }
```

### 5) Update saat orderflow snapshot masuk (optional tapi bagus)

Di `applyOrderflowSnapshotToCandidate(item, snapshot)` setelah set orderflow fields:

* panggil recompute untuk `currentCandidates` **atau** minimal recompute untuk pageRows (biar ringan).
  Paling simpel (tanpa mikirin performa dulu):

```js
// after applying snapshot for one item:
recomputeProbColumns(currentCandidates);
updateProbCells(symbol, item);
```

dan implement `updateProbCells` seperti `updateOrderflowCells`.

---

## Kenapa ini “lebih aman” dari overfitting?

* Threshold diganti **ranking relatif** → robust terhadap perubahan rezim market & scaling (CVD/value yang heavy-tail).
* Mapping prob konservatif dan **hanya mengangkat skor kalau sinyal positif konsisten** (raw negatif tidak bikin “prob” tinggi).
* Likuiditas tidak pakai cutoff statis (lebih sulit “curi” pola).

