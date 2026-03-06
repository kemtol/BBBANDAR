/**
 * most-active-pipeline.js
 * PRD 0012 — Most Active Alert: Browser-side live pipeline
 *
 * Classes:
 *  ScoreMath           — clip/norm helpers (§29.1)
 *  RankTrailStore      — ring buffer, deltas, slope (FR-8)
 *  Ob2RollingMetrics   — BSS/ATS from OB2 stream (FR-7, §29.3–§29.4)
 *  HotScoreEngine      — full stage score (§29.2–§29.9)
 *  MostActiveClient    — WS connection + 60s roster query (FR-1)
 *  OrderbookClient     — OB2 subscribe/unsubscribe lifecycle (FR-3, P0)
 *  MostActiveOrchestrator — minute loop + micro tick (§31)
 *
 * Exports: window.MostActivePipeline
 */

'use strict';

// ============================================================
// 1. SCORE MATH  (PRD §29.1)
// ============================================================
const ScoreMath = {
    clip(x, lo, hi) {
        return Math.min(Math.max(x, lo), hi);
    },
    norm(x, lo, hi) {
        const range = hi - lo;
        if (!range) return 0;
        return 100 * (this.clip(x, lo, hi) - lo) / range;
    },
    /**
     * Cross-sectional percentile rank.
     * Returns 0.0–1.0 where 1.0 = highest in cohort.
     * Handles ties by averaging (standard competition ranking).
     */
    percentileRank(value, allValues) {
        if (!allValues.length) return 0.5;
        if (allValues.length === 1) return 0.5;
        let below = 0, equal = 0;
        for (const v of allValues) {
            if (v < value) below++;
            else if (v === value) equal++;
        }
        return (below + 0.5 * equal) / allValues.length;
    },
    /**
     * Linear regression slope over an array of values.
     * Returns slope in units-per-index (positive = rising).
     */
    linearSlope(arr) {
        const n = arr.length;
        if (n < 3) return 0;
        const xMean = (n - 1) / 2;
        const yMean = arr.reduce((s, v) => s + v, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
            num += (i - xMean) * (arr[i] - yMean);
            den += (i - xMean) * (i - xMean);
        }
        return den > 0 ? num / den : 0;
    }
};

// ============================================================
// 2. RANK TRAIL STORE  (FR-8, PRD §29.6)
// ============================================================
class RankTrailStore {
    constructor(maxPoints = 60) {
        this._max = maxPoints;
        // code → { trail: (number|null)[], consecutive: number, lastMinuteKey: string }
        this._store = new Map();
    }

    /** Record rank for symbol this minute cycle */
    update(code, rank, minuteKey) {
        if (!this._store.has(code)) {
            this._store.set(code, { trail: [], consecutive: 0, lastMinuteKey: null });
        }
        const e = this._store.get(code);
        e.trail.push(Number(rank));
        if (e.trail.length > this._max) e.trail.shift();
        e.consecutive += 1;
        e.lastMinuteKey = minuteKey;
    }

    /** Mark symbol as absent from roster this minute */
    markAbsent(code, minuteKey) {
        if (!this._store.has(code)) return;
        const e = this._store.get(code);
        e.trail.push(null);
        if (e.trail.length > this._max) e.trail.shift();
        e.consecutive = 0;
        e.lastMinuteKey = minuteKey;
    }

    /** For all known symbols not in activeSet, mark absent */
    expireAbsent(activeSet, minuteKey) {
        for (const [code] of this._store) {
            if (!activeSet.has(code)) {
                this.markAbsent(code, minuteKey);
            }
        }
    }

    getTrail(code) { return this._store.get(code)?.trail ?? []; }
    getConsecutive(code) { return this._store.get(code)?.consecutive ?? 0; }

    /**
     * Returns rank delta over last `minutesBack` non-null points.
     * Negative = rank improved (lower number = better).
     */
    getRankDelta(code, minutesBack) {
        const trail = this.getTrail(code);
        const nonNull = trail.filter(v => v !== null);
        if (nonNull.length < 2) return 0;
        const current = nonNull[nonNull.length - 1];
        const ref = nonNull[Math.max(0, nonNull.length - 1 - minutesBack)];
        return current - ref; // negative → improved
    }

    /**
     * Simple linear-regression slope over last 10 non-null points.
     * Negative slope → rank improving over time.
     */
    getRankSlope10m(code) {
        const trail = this.getTrail(code);
        const pts = trail.filter(v => v !== null).slice(-10);
        if (pts.length < 3) return 0;
        const n = pts.length;
        const xMean = (n - 1) / 2;
        const yMean = pts.reduce((s, v) => s + v, 0) / n;
        let num = 0, den = 0;
        pts.forEach((y, i) => {
            num += (i - xMean) * (y - yMean);
            den += (i - xMean) ** 2;
        });
        return den ? num / den : 0;
    }

    allKnownCodes() { return [...this._store.keys()]; }

    // ---- localStorage persistence (intraday) ----
    static _LS_KEY = 'ma_rank_trail_v1';

    /** Serialize to JSON-safe object */
    toJSON() {
        const entries = {};
        for (const [code, e] of this._store) {
            entries[code] = { trail: e.trail, consecutive: e.consecutive, lastMinuteKey: e.lastMinuteKey };
        }
        return { ts: Date.now(), date: new Date().toISOString().slice(0, 10), max: this._max, entries };
    }

    /** Restore from JSON object (same trading day only) */
    restoreFromJSON(obj) {
        if (!obj?.entries || !obj.date) return 0;
        const today = new Date().toISOString().slice(0, 10);
        if (obj.date !== today) {
            console.log('[RankTrailStore] discarding stale cache from', obj.date);
            return 0;
        }
        let count = 0;
        for (const [code, e] of Object.entries(obj.entries)) {
            if (!this._store.has(code)) {
                this._store.set(code, {
                    trail: (e.trail ?? []).slice(-(this._max)),
                    consecutive: e.consecutive ?? 0,
                    lastMinuteKey: e.lastMinuteKey ?? null
                });
                count++;
            }
        }
        return count;
    }

    saveToLocalStorage() {
        try {
            localStorage.setItem(RankTrailStore._LS_KEY, JSON.stringify(this.toJSON()));
        } catch (e) { /* quota exceeded — non-fatal */ }
    }

    restoreFromLocalStorage() {
        try {
            const raw = localStorage.getItem(RankTrailStore._LS_KEY);
            if (!raw) return 0;
            return this.restoreFromJSON(JSON.parse(raw));
        } catch (e) { return 0; }
    }
}

// ============================================================
// 3. OB2 ROLLING METRICS  (FR-7, PRD §29.3–§29.4)
// Each instance tracks ONE symbol's rolling OB2 window.
// ============================================================
class Ob2RollingMetrics {
    constructor(windowSize = 60) {
        this._ws = windowSize;
        // { ts, bidTotalL5, askTotalL5, bestBid, bestAsk, spreadBps }
        this._buf = [];
        this._bss = 50;
        this._ats = 50;
        this._spreadBpsAvg = 20;
        this._lastPx = 0;
        this._updateCount = 0;
    }

    _sumQty(levels, n) {
        let total = 0;
        for (let i = 0; i < Math.min(n, levels.length); i++) {
            total += Number(levels[i][1] || 0);
        }
        return total;
    }

    push(bid, ask) {
        if (!bid?.length || !ask?.length) return;
        const bestBid = Number(bid[0]?.[0]) || 0;
        const bestAsk = Number(ask[0]?.[0]) || 0;
        const bidTotalL5 = this._sumQty(bid, 5);
        const askTotalL5 = this._sumQty(ask, 5);
        const spreadBps = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 10000 : 20;
        this._buf.push({ ts: Date.now(), bidTotalL5, askTotalL5, bestBid, bestAsk, spreadBps });
        if (this._buf.length > this._ws) this._buf.shift();
        this._lastPx = bestBid;
        this._updateCount++;
        this._recompute();
    }

    _recompute() {
        const buf = this._buf;
        if (buf.length < 2) return;
        const n = buf.length;
        const prev = buf[0];
        const curr = buf[n - 1];

        // --- BSS (PRD §29.3) ---
        // b1: bid qty L1-L5 delta pct over window
        const bidDelta = prev.bidTotalL5 > 0
            ? ((curr.bidTotalL5 - prev.bidTotalL5) / prev.bidTotalL5) * 100
            : 0;
        // b2: bid refill rate — fraction of ticks where bid qty increased
        let bidInc = 0;
        for (let i = 1; i < n; i++) {
            if (buf[i].bidTotalL5 > buf[i - 1].bidTotalL5) bidInc++;
        }
        const bidRefillRate = (n - 1) > 0 ? bidInc / (n - 1) : 0;
        // b3: best bid price stability — fraction of ticks where best bid unchanged
        let bidStable = 0;
        for (let i = 1; i < n; i++) {
            if (buf[i].bestBid === buf[i - 1].bestBid) bidStable++;
        }
        const bestBidStability = (n - 1) > 0 ? bidStable / (n - 1) : 0.5;

        const b1 = ScoreMath.norm(bidDelta, -10, 40);
        const b2 = ScoreMath.norm(bidRefillRate, 0.0, 1.2);
        const b3 = ScoreMath.norm(bestBidStability, 0.2, 1.0);
        this._bss = ScoreMath.clip(0.45 * b1 + 0.35 * b2 + 0.20 * b3, 0, 100);

        // --- ATS (PRD §29.4) ---
        // a1: ask qty L1-L5 drop pct over window
        const askDrop = prev.askTotalL5 > 0
            ? ((prev.askTotalL5 - curr.askTotalL5) / prev.askTotalL5) * 100
            : 0;
        // a2: ask eaten rate — fraction of ticks where ask qty decreased
        let askDec = 0;
        for (let i = 1; i < n; i++) {
            if (buf[i].askTotalL5 < buf[i - 1].askTotalL5) askDec++;
        }
        const askEatenRate = (n - 1) > 0 ? askDec / (n - 1) : 0;
        // a3: ask wall reappear penalty — large ask qty jumps back after eating
        const sortedAsk = [...buf].map(b => b.askTotalL5).sort((a, b) => a - b);
        const medianAsk = sortedAsk[Math.floor(n / 2)] || 1;
        let wallCount = 0;
        for (let i = 1; i < n; i++) {
            if (buf[i].askTotalL5 > buf[i - 1].askTotalL5 &&
                buf[i].askTotalL5 >= medianAsk * 1.5) {
                wallCount++;
            }
        }
        const askWallPenalty = ScoreMath.clip((wallCount / Math.max(1, n - 1)) * 200, 0, 100);

        const a1 = ScoreMath.norm(askDrop, -10, 40);
        const a2 = ScoreMath.norm(askEatenRate, 0.0, 1.2);
        const a3 = 100 - askWallPenalty;
        this._ats = ScoreMath.clip(0.45 * a1 + 0.35 * a2 + 0.20 * a3, 0, 100);

        // Spread avg
        this._spreadBpsAvg = buf.reduce((s, b) => s + b.spreadBps, 0) / n;
    }

    get bss() { return Math.round(this._bss); }
    get ats() { return Math.round(this._ats); }
    get spreadBpsAvg() { return this._spreadBpsAvg; }
    get lastPx() { return this._lastPx; }
    get updateCount() { return this._updateCount; }

    getState() {
        const b = this._bss >= 65, a = this._ats >= 65;
        const by = this._bss >= 45, ay = this._ats >= 45;
        if (b && a) return 'GREEN_GREEN';
        if (b && ay) return 'GREEN_YELLOW';
        if (by && !ay) return 'YELLOW_RED';
        return 'RED_RED';
    }

    getIndicator() {
        return {
            bss: this.bss,
            ats: this.ats,
            state: this.getState(),
            spread_bps_avg: Math.round(this._spreadBpsAvg * 10) / 10,
            missing: this._updateCount < 2
        };
    }
}

// ============================================================
// 4. HOT SCORE ENGINE  (PRD §29)
// ============================================================
class HotScoreEngine {
    constructor(rankTrailStore) {
        this._trail = rankTrailStore;
        this._ob2 = new Map();    // code → Ob2RollingMetrics
        this._valueBuf = new Map(); // code → number[] (last 5 min)
        this._volBuf = new Map();   // code → number[] (last 5 min)
        // Pressure Index trail — aggregated into 1-min buckets (full trading day)
        this._pressureTrail = new Map();   // code → { buckets: number[], accum: number[], bucketStart: number|null }
        this._PI_BUCKET_MS = 1 * 60 * 1000; // 1 minute
        this._MAX_PI_BUCKETS = 360;         // full trading day (09:00-15:00 = 360 minutes)
        // CVD trail — 1-min buckets (full trading day), mirrors pressure trail structure
        this._cvdTrail = new Map();   // code → { buckets: number[], lastValue: number|null, bucketStart: number|null }
        // External data injection (set by orchestrator from _footprintMap / _sectorCvdMap)
        this._externalData = new Map(); // code → { cvd, div_detected, div_score, div_type, chg_pct }
    }

    ensureOb2(code) {
        if (!this._ob2.has(code)) this._ob2.set(code, new Ob2RollingMetrics(60));
        return this._ob2.get(code);
    }

    pushOb2(code, bid, ask) {
        this.ensureOb2(code).push(bid, ask);
    }

    pushRosterRow(code, value, volume) {
        const vb = this._valueBuf.get(code) ?? [];
        const ob = this._volBuf.get(code) ?? [];
        vb.push(Number(value) || 0);
        ob.push(Number(volume) || 0);
        if (vb.length > 5) vb.shift();
        if (ob.length > 5) ob.shift();
        this._valueBuf.set(code, vb);
        this._volBuf.set(code, ob);
    }

    getOb2Indicator(code) {
        const ob2 = this._ob2.get(code);
        if (!ob2 || ob2.updateCount < 2) {
            return { bss: 50, ats: 50, state: 'YELLOW_RED', missing: true };
        }
        return ob2.getIndicator();
    }

    /**
     * Pressure Index (PI): composite 0-100 score of bid/offer microstructure health.
     * Formula: 0.40*BSS + 0.40*ATS + 0.20*spread_health
     * Returned as integer 0-100. When OB2 data is missing, returns null.
     */
    getPressureIndex(code) {
        const ob2 = this._ob2.get(code);
        if (!ob2 || ob2.updateCount < 2) return null;
        const spread_health = 100 - ScoreMath.norm(ob2.spreadBpsAvg, 10, 80);
        return Math.round(ScoreMath.clip(
            0.40 * ob2.bss + 0.40 * ob2.ats + 0.20 * spread_health, 0, 100
        ));
    }

    /** Push one pressure tick for a symbol (call every micro cycle = 5s).
     *  Aggregates into 1-min bucket averages automatically (rolling 60 minutes). */
    pushPressureTick(code) {
        const pi = this.getPressureIndex(code);
        if (pi === null) return; // don't push null — wait for OB2 data
        const now = Date.now();
        let state = this._pressureTrail.get(code);
        if (!state) {
            state = { buckets: [], accum: [], bucketStart: now };
            this._pressureTrail.set(code, state);
        }
        // Close as many elapsed buckets as needed (handles multi-minute gaps)
        let elapsed = now - state.bucketStart;
        while (elapsed >= this._PI_BUCKET_MS) {
            if (state.accum.length > 0) {
                // Close current bucket: compute average
                const avg = state.accum.reduce((s, v) => s + v, 0) / state.accum.length;
                state.buckets.push(Math.round(avg * 10) / 10);
                state.accum = [];
            } else if (state.buckets.length > 0) {
                // No data in this minute — carry forward last known value
                state.buckets.push(state.buckets[state.buckets.length - 1]);
            }
            if (state.buckets.length > this._MAX_PI_BUCKETS) state.buckets.shift();
            state.bucketStart += this._PI_BUCKET_MS;
            elapsed = now - state.bucketStart;
        }
        state.accum.push(pi);
    }

    /** Get the pressure trail array for sparkline rendering.
     *  Returns array of 1-min bucket averages + current partial bucket (max 60). */
    getPressureTrail(code) {
        const state = this._pressureTrail.get(code);
        if (!state) return [];
        // Include finalized buckets + current partial bucket average
        const result = [...state.buckets];
        if (state.accum.length > 0) {
            const avg = state.accum.reduce((s, v) => s + v, 0) / state.accum.length;
            result.push(Math.round(avg * 10) / 10);
        }
        return result;
    }

    // ---- localStorage persistence (intraday) ----
    static _LS_KEY = 'ma_pressure_trail_v1';

    /** Serialize pressure trail to JSON-safe object */
    pressureTrailToJSON() {
        const entries = {};
        for (const [code, state] of this._pressureTrail) {
            // Flush current accum into buckets snapshot
            const finalBuckets = [...state.buckets];
            if (state.accum.length > 0) {
                const avg = state.accum.reduce((s, v) => s + v, 0) / state.accum.length;
                finalBuckets.push(Math.round(avg * 10) / 10);
            }
            entries[code] = finalBuckets;
        }
        return { ts: Date.now(), date: new Date().toISOString().slice(0, 10), entries };
    }

    /** Restore pressure trail from JSON (same trading day only) */
    restorePressureTrailFromJSON(obj) {
        if (!obj?.entries || !obj.date) return 0;
        const today = new Date().toISOString().slice(0, 10);
        if (obj.date !== today) {
            console.log('[HotScoreEngine] discarding stale pressure cache from', obj.date);
            return 0;
        }
        let count = 0;
        for (const [code, buckets] of Object.entries(obj.entries)) {
            if (!Array.isArray(buckets) || !buckets.length) continue;
            if (!this._pressureTrail.has(code)) {
                this._pressureTrail.set(code, {
                    buckets: buckets.slice(-(this._MAX_PI_BUCKETS)),
                    accum: [],
                    bucketStart: Date.now()
                });
                count++;
            }
        }
        return count;
    }

    savePressureTrailToLocalStorage() {
        try {
            localStorage.setItem(HotScoreEngine._LS_KEY, JSON.stringify(this.pressureTrailToJSON()));
        } catch (e) { /* quota exceeded — non-fatal */ }
    }

    restorePressureTrailFromLocalStorage() {
        try {
            const raw = localStorage.getItem(HotScoreEngine._LS_KEY);
            if (!raw) return 0;
            return this.restorePressureTrailFromJSON(JSON.parse(raw));
        } catch (e) { return 0; }
    }

    // ---- CVD Trail (1-min buckets, full trading day) ----

    /** Push CVD value for a symbol. Call every minute tick from orchestrator. */
    pushCvdTick(code, cvdValue) {
        if (cvdValue == null || !Number.isFinite(cvdValue)) return;
        const now = Date.now();
        let state = this._cvdTrail.get(code);
        if (!state) {
            state = { buckets: [], lastValue: null, bucketStart: now };
            this._cvdTrail.set(code, state);
        }
        // Close elapsed buckets (carry-forward for gaps)
        let elapsed = now - state.bucketStart;
        while (elapsed >= this._PI_BUCKET_MS) {
            if (state.lastValue != null) {
                state.buckets.push(state.lastValue);
            } else if (state.buckets.length > 0) {
                state.buckets.push(state.buckets[state.buckets.length - 1]);
            }
            if (state.buckets.length > this._MAX_PI_BUCKETS) state.buckets.shift();
            state.bucketStart += this._PI_BUCKET_MS;
            elapsed = now - state.bucketStart;
        }
        state.lastValue = cvdValue;
    }

    /** Get CVD trail array for slope computation (max 360 values, full day). */
    getCvdTrail(code) {
        const state = this._cvdTrail.get(code);
        if (!state) return [];
        const result = [...state.buckets];
        if (state.lastValue != null) result.push(state.lastValue);
        return result;
    }

    /** Inject external data (footprint, sector CVD) for use in computeV2. */
    setExternalData(code, data) {
        this._externalData.set(code, data);
    }

    // ---- CVD Trail localStorage persistence ----
    static _CVD_LS_KEY = 'ma_cvd_trail_v1';

    cvdTrailToJSON() {
        const entries = {};
        for (const [code, state] of this._cvdTrail) {
            const final = [...state.buckets];
            if (state.lastValue != null) final.push(state.lastValue);
            entries[code] = final;
        }
        return { ts: Date.now(), date: new Date().toISOString().slice(0, 10), entries };
    }

    restoreCvdTrailFromJSON(obj) {
        if (!obj?.entries || !obj.date) return 0;
        const today = new Date().toISOString().slice(0, 10);
        if (obj.date !== today) return 0;
        let count = 0;
        for (const [code, buckets] of Object.entries(obj.entries)) {
            if (!Array.isArray(buckets) || !buckets.length) continue;
            if (!this._cvdTrail.has(code)) {
                this._cvdTrail.set(code, {
                    buckets: buckets.slice(-(this._MAX_PI_BUCKETS)),
                    lastValue: buckets[buckets.length - 1] ?? null,
                    bucketStart: Date.now()
                });
                count++;
            }
        }
        return count;
    }

    saveCvdTrailToLocalStorage() {
        try {
            localStorage.setItem(HotScoreEngine._CVD_LS_KEY, JSON.stringify(this.cvdTrailToJSON()));
        } catch (e) { /* quota exceeded — non-fatal */ }
    }

    restoreCvdTrailFromLocalStorage() {
        try {
            const raw = localStorage.getItem(HotScoreEngine._CVD_LS_KEY);
            if (!raw) return 0;
            return this.restoreCvdTrailFromJSON(JSON.parse(raw));
        } catch (e) { return 0; }
    }

    // ============================================================
    //  CONTINUATION SCORE v2.0  — Cross-sectional percentile model
    //  Replaces v1 compute() for next-day continuation prediction.
    // ============================================================

    /**
     * Batch-compute v2 scores for the entire roster cohort.
     * Must be called with ALL roster rows so percentiles are meaningful.
     *
     * @param {Array<{code,rank,maxRank,chg_pct,value}>} rosterContext
     * @returns {Map<string, {stage_score, stage_label, reason_codes, components}>}
     */
    batchComputeV2(rosterContext) {
        if (!rosterContext.length) return new Map();

        // ── 1. Collect raw signal arrays for percentile computation ──
        const codes   = rosterContext.map(r => r.code);
        const chgArr  = rosterContext.map(r => r.chg_pct ?? 0);
        const valArr  = rosterContext.map(r => r.value ?? 0);
        const piArr   = rosterContext.map(r => this.getPressureIndex(r.code) ?? 50);
        const cvdArr  = rosterContext.map(r => {
            const ext = this._externalData.get(r.code);
            return ext?.cvd ?? 0;
        });

        // Pre-compute ExtremeMove stats once (mean + 2σ of |CHG%|) — avoids O(n²)
        const absCHGs = rosterContext.map(r => Math.abs(r.chg_pct ?? 0));
        const chgMean = absCHGs.reduce((s, v) => s + v, 0) / absCHGs.length;
        const chgStd  = Math.sqrt(absCHGs.reduce((s, v) => s + (v - chgMean) ** 2, 0) / absCHGs.length) || 1;
        const extremeThreshold = chgMean + 2 * chgStd;

        const results = new Map();

        for (let idx = 0; idx < rosterContext.length; idx++) {
            const r = rosterContext[idx];
            const code = r.code;
            const ext = this._externalData.get(code) || {};
            const ob2 = this._ob2.get(code);

            // ── 2. Cross-sectional percentiles (0–1) ──
            const M = ScoreMath.percentileRank(chgArr[idx], chgArr);
            const V = ScoreMath.percentileRank(valArr[idx], valArr);
            const P = ScoreMath.percentileRank(piArr[idx],  piArr);
            const C = ScoreMath.percentileRank(cvdArr[idx], cvdArr);

            // ── 3. Slope signals (0–1 normalized) ──
            const pTrail = this.getPressureTrail(code);
            const pSlice = pTrail.slice(-30); // last 30 minutes
            const pSlope = ScoreMath.linearSlope(pSlice);
            const Ps = ScoreMath.clip((pSlope + 2) / 4, 0, 1); // [-2,+2] → [0,1]

            const cTrail = this.getCvdTrail(code);
            const cSlice = cTrail.slice(-30);
            const cSlope = ScoreMath.linearSlope(cSlice);
            const Cs = ScoreMath.clip((cSlope + 2) / 4, 0, 1);

            // ── 4. Microstructure signals (0–1) ──
            const B = (ob2 && ob2.updateCount >= 2) ? ob2.bss / 100 : 0.5;
            const O = (ob2 && ob2.updateCount >= 2) ? ob2.ats / 100 : 0.5;

            // ── 5. Penalties (0 or 1) ──
            let Div = 0;
            if (ext.div_detected && Math.abs(ext.div_score ?? 0) > 1.5) {
                Div = 1;
            } else {
                // Heuristic divergence: CHG% positive but CVD negative (or vice versa)
                const chg = r.chg_pct ?? 0;
                const cvd = ext.cvd ?? 0;
                if (Math.abs(chg) > 1.5 && Math.abs(cvd) > 50) {
                    if ((chg > 0 && cvd < 0) || (chg < 0 && cvd > 0)) Div = 1;
                }
            }

            // ExtremeMove: |CHG%| > mean + 2σ of roster (pre-computed above loop)
            const Extreme = Math.abs(r.chg_pct ?? 0) > extremeThreshold ? 1 : 0;

            // ── 6. Weighted formula ──
            let raw = 0.10 * M
                    + 0.10 * V
                    + 0.20 * P
                    + 0.10 * Ps
                    + 0.20 * C
                    + 0.10 * Cs
                    + 0.10 * B
                    + 0.10 * O
                    - 0.25 * Div
                    - 0.10 * Extreme;

            const score = Math.round(100 * ScoreMath.clip(raw, 0, 1));

            // ── 7. Gating: score > 70 requires strong microstructure ──
            let gatedScore = score;
            if (score > 70) {
                const gatePass = P > 0.6
                              && (B > 0.6 || O > 0.6)
                              && Div === 0;
                if (!gatePass) gatedScore = Math.min(score, 69);
            }

            // ── 8. Stage label ──
            let stage_label;
            if (gatedScore >= 70)      stage_label = 'Strong Continuation';
            else if (gatedScore >= 50) stage_label = 'Watch';
            else                       stage_label = 'Cooling';

            // ── 9. Reason codes ──
            const reason_codes = this._buildReasonCodesV2(code, {
                M, V, P, Ps, C, Cs, B, O, Div, Extreme, gatedScore,
                pSlope, cSlope
            });

            // ── 10. Component breakdown (for tooltip/debug) ──
            const components = {
                M: Math.round(M * 100),
                V: Math.round(V * 100),
                P: Math.round(P * 100),
                Ps: Math.round(Ps * 100),
                C: Math.round(C * 100),
                Cs: Math.round(Cs * 100),
                B: Math.round(B * 100),
                O: Math.round(O * 100),
                Div, Extreme,
                raw: Math.round(raw * 100),
                gated: gatedScore !== score
            };

            results.set(code, {
                stage_score: gatedScore,
                stage_label,
                reason_codes,
                components,
                risk_memory_missing: true // FR-9 deferred
            });
        }

        return results;
    }

    /**
     * Single-symbol compute (backward compat). Delegates to batchComputeV2
     * with a 1-element roster. Percentiles are meaningless with N=1;
     * only use for OB2 micro-tick updates between minute cycles.
     */
    compute(code, rankNow, maxRank, riskMemory = null) {
        const r = { code, rank: rankNow, maxRank,
            chg_pct: this._externalData.get(code)?.chg_pct ?? 0,
            value:   (this._valueBuf.get(code) ?? [])[0] ?? 0
        };
        const results = this.batchComputeV2([r]);
        return results.get(code) ?? {
            stage_score: 0, stage_label: 'Cooling',
            reason_codes: ['insufficient_data'], components: {}
        };
    }

    _buildReasonCodesV2(code, { M, V, P, Ps, C, Cs, B, O, Div, Extreme, gatedScore, pSlope, cSlope }) {
        const scored = [];

        // Positive signals
        if (P > 0.75)  scored.push({ code: 'pressure_dominant',        w: P });
        if (Ps > 0.7)  scored.push({ code: 'pressure_rising',          w: Ps });
        if (C > 0.75)  scored.push({ code: 'cvd_dominant',             w: C });
        if (Cs > 0.7)  scored.push({ code: 'cvd_accelerating',         w: Cs });
        if (B > 0.65)  scored.push({ code: 'bid_stack_persistent',     w: B });
        if (O > 0.65)  scored.push({ code: 'ask_thinning_consistent',  w: O });
        if (V > 0.8)   scored.push({ code: 'high_value_institutional', w: V });
        if (M > 0.75)  scored.push({ code: 'strong_momentum',          w: M });

        // Negative signals
        if (Div)        scored.push({ code: 'divergence_detected',     w: 0.95 });
        if (Extreme)    scored.push({ code: 'extreme_move_caution',    w: 0.90 });
        if (P < 0.3)    scored.push({ code: 'pressure_weak',           w: 1 - P });
        if (Ps < 0.3)   scored.push({ code: 'pressure_fading',         w: 1 - Ps });
        if (C < 0.3)    scored.push({ code: 'cvd_weak',                w: 1 - C });
        if (Cs < 0.3)   scored.push({ code: 'cvd_decelerating',        w: 1 - Cs });
        if (B < 0.35)   scored.push({ code: 'bid_pullback_fast',       w: 1 - B });
        if (O < 0.35)   scored.push({ code: 'ask_wall_reappearing',    w: 1 - O });

        // Neutral
        if (gatedScore > 70 && gatedScore < 100)
            scored.push({ code: 'continuation_candidate', w: 0.5 });

        // Rank trail context (kept from v1 for UX)
        const delta5  = this._trail.getRankDelta(code, 5);
        const delta15 = this._trail.getRankDelta(code, 15);
        if (delta15 < -3) scored.push({ code: 'rank_improving_15m', w: Math.abs(delta15) / 10 });
        if (delta5  >  2) scored.push({ code: 'rank_deteriorating_5m', w: delta5 / 10 });

        const sorted = [...new Set(
            scored.sort((a, b) => b.w - a.w).map(c => c.code)
        )];
        const result = sorted.slice(0, 6);
        while (result.length < 2) result.push('neutral');
        return result;
    }
}

// ============================================================
// 5. MOST ACTIVE CLIENT  (FR-1)
// WebSocket to IPOT SocketCluster — roster query every 60s
// ============================================================
class MostActiveClient {
    /**
     * @param {object} opts
     * @param {string}   opts.wsUrl        wss://ipotapp.ipot.id/socketcluster/?appsession=TOKEN
     * @param {function} opts.onRoster     callback(rows: RosterRow[])
     * @param {function} opts.onAnyMessage callback(parsedMsg) for OB2 etc.
     * @param {function} opts.onStatus     callback('LIVE'|'DEGRADED'|'STALE')
     */
    constructor({ wsUrl, onRoster, onAnyMessage, onStatus }) {
        this._wsUrl = wsUrl;
        this._onRoster = onRoster;
        this._onAnyMessage = onAnyMessage || (() => {});
        this._onStatus = onStatus || (() => {});
        this._ws = null;
        this._cid = 0;
        this._reconnectTimer = null;
        this._pingTimer = null;
        this._reconnectDelay = 3000;
        this._maxReconnectDelay = 60000;
        this._connected = false;
        this._destroyed = false;
        this._pendingRids = new Map(); // cid → { type, cmdid }
        // Record-streaming state (IPOT HOLD / "reply as record" pattern)
        this._recordCmdid = null;   // cmdid we're collecting records for
        this._recordBuffer = [];    // collected record data
        this._colMapping = null;    // auto-detected column mapping
        // Dual G/L roster state
        this._dualRosterPending = 0;
        this._dualRosterRows = [];
        this._rosterCmdidGain = null;
        this._rosterCmdidLoss = null;
    }

    connect() {
        if (this._destroyed) return;
        this._cleanup();
        console.log('[MostActiveClient] connecting…');
        try {
            this._ws = new WebSocket(this._wsUrl);
            this._ws.onopen    = ()  => this._onOpen();
            this._ws.onmessage = (e) => this._onMsg(e.data);
            this._ws.onclose   = (e) => this._onClose(e);
            this._ws.onerror   = (e) => console.error('[MostActiveClient] WS error', e);
        } catch (err) {
            console.error('[MostActiveClient] connect error', err);
            this._scheduleReconnect();
        }
    }

    destroy() {
        this._destroyed = true;
        this._cleanup();
    }

    send(obj) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    queryRoster() {
        if (!this._connected) return;
        const now = new Date();
        const wibParts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric', month: 'numeric', day: 'numeric'
        }).formatToParts(now);
        const gp = (t) => wibParts.find(p => p.type === t)?.value || '';
        // IPOT expects YYYY-M-D (no leading zeros)
        const dateStr = `${gp('year')}-${Number(gp('month'))}-${Number(gp('day'))}`;
        this._rosterDateStr = dateStr;

        // Top G/L: send gainers first, then losers after gainers complete.
        // Both use record-streaming (HOLD pattern) which only supports one
        // active cmdid at a time, so queries MUST be sequential.
        this._dualRosterPending = 2;
        this._dualRosterRows = [];

        console.log(`[MostActiveClient] queryRoster (dual G/L) — Phase 1: gainers, date=${dateStr}`);
        this._sendGainersQuery(dateStr);
    }

    /** Phase 1: Top Gainers (pchg DESC) */
    _sendGainersQuery(dateStr) {
        const cid = this._nextCid();
        this._rosterCmdidGain = 94;
        this._pendingRids.set(cid, { type: 'roster', cmdid: 94 });
        this.send({
            event: 'cmd',
            data: {
                cmdid: 94,
                param: {
                    cmd: 'query',
                    service: 'midata',
                    param: {
                        source: 'datafeed',
                        index: 'xen_qu_top_stock_gl',
                        args: ['COMPOSITE', dateStr, dateStr],
                        info: { orderby: [[3, 'DESC', 'N']], sum: [6] },
                        pagelen: 30,
                        slid: ''
                    }
                }
            },
            cid
        });
    }

    /** Phase 2: Top Losers (pchg ASC) — called after gainers complete */
    _sendLosersQuery() {
        if (!this._connected || !this._rosterDateStr) return;
        const dateStr = this._rosterDateStr;
        const cid = this._nextCid();
        this._rosterCmdidLoss = 95;
        this._pendingRids.set(cid, { type: 'roster', cmdid: 95 });
        this.send({
            event: 'cmd',
            data: {
                cmdid: 95,
                param: {
                    cmd: 'query',
                    service: 'midata',
                    param: {
                        source: 'datafeed',
                        index: 'xen_qu_top_stock_gl',
                        args: ['COMPOSITE', dateStr, dateStr],
                        info: { orderby: [[3, 'ASC', 'N']], sum: [6] },
                        pagelen: 30,
                        slid: ''
                    }
                }
            },
            cid
        });
        console.log(`[MostActiveClient] queryRoster (dual G/L) — Phase 2: losers, cid=${cid}`);
    }

    /**
     * Called when one side of the dual G/L query completes.
     * After gainers finish → sends losers query.
     * After losers finish → merges, deduplicates, sorts by |%CHG| desc.
     */
    _collectDualRoster(parsed) {
        this._dualRosterRows.push(...parsed);
        this._dualRosterPending--;

        if (this._dualRosterPending === 1) {
            // Gainers done — now send losers query (sequential to avoid HOLD collision)
            console.log(`[MostActiveClient] dual G/L: gainers done (${parsed.length} rows). Sending losers query…`);
            this._sendLosersQuery();
            return;
        }
        if (this._dualRosterPending > 0) return; // safety

        // Both done — merge
        const seen = new Set();
        const merged = [];
        for (const r of this._dualRosterRows) {
            if (seen.has(r.code)) continue;
            seen.add(r.code);
            merged.push(r);
        }

        // Sort by absolute %CHG descending (biggest movers first)
        merged.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

        // Re-assign rank based on merged order
        merged.forEach((r, i) => { r.rank = i + 1; });

        console.log(`[MostActiveClient] dual G/L merged: ${merged.length} symbols. Top 5:`,
            merged.slice(0, 5).map(r => `${r.code} ${r.change_pct > 0 ? '+' : ''}${r.change_pct?.toFixed(1)}%`).join(', ')
        );

        if (merged.length) {
            this._onRoster(merged);
        }
        this._dualRosterRows = [];
    }

    // ---- private ----

    _nextCid() { return ++this._cid; }

    _onOpen() {
        console.log('[MostActiveClient] WS open');
        this._reconnectDelay = 3000;
        this._connected = true;
        this._onStatus('LIVE');
        // SC handshake
        const cid = this._nextCid();
        this._pendingRids.set(cid, { type: 'handshake' });
        this.send({ event: '#handshake', data: { authToken: null }, cid });
        // Keep-alive ping every 20s
        this._pingTimer = setInterval(() => {
            if (this._ws?.readyState === WebSocket.OPEN) this._ws.send('#1');
        }, 20000);
    }

    _onMsg(raw) {
        // SC ping/pong
        if (raw === '#1') { this._ws?.send('#2'); return; }
        if (raw === '#2') return;

        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // Always forward stream/#publish to OB2 handler first (never swallowed by record mode)
        const evType = msg?.event;
        if (evType === 'stream' || evType === '#publish') {
            this._onAnyMessage(msg);
            return; // OB2 push — do not process further
        }

        // Forward other messages to external handler
        this._onAnyMessage(msg);

        // ── DEBUG: Log ALL messages while waiting for record stream ──
        if (this._recordCmdid !== null) {
            // Compact debug: event type, top-level keys, and data.cmdid if present
            const snippet = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
            if (!this._recordDebugCount) this._recordDebugCount = 0;
            this._recordDebugCount++;
            if (this._recordDebugCount <= 5) {
                console.debug(`[MostActiveClient] record-mode msg #${this._recordDebugCount}: event=${msg?.event}, data.cmdid=${msg?.data?.cmdid}, data.event=${msg?.data?.event}, keys=${Object.keys(msg).join(',')}, raw=${snippet}`);
            }
        }

        // ── Record-streaming: collect rows (IPOT "reply as record" pattern) ──
        // Match by event name OR by data.cmdid matching our target
        if (this._recordCmdid !== null) {
            const ev = msg?.event ?? msg?.data?.event;
            const msgCmdid = Number(msg?.data?.cmdid ?? msg?.data?.data?.cmdid ?? -1);

            if (ev === 'record' && (msgCmdid === this._recordCmdid || msgCmdid === -1)) {
                const payload = msg?.data?.data;
                this._recordBuffer.push(payload);
                return;
            }

            // Terminator: event="res" with matching cmdid
            if (ev === 'res') {
                if (msgCmdid === this._recordCmdid || (this._recordBuffer.length > 0 && msgCmdid === -1)) {
                    const records = this._recordBuffer;
                    this._recordCmdid = null;
                    this._recordBuffer = [];
                    this._recordDebugCount = 0;
                    clearTimeout(this._recordTimeout);
                    console.log(`[MostActiveClient] record-stream complete: ${records.length} records`);
                    if (records.length) {
                        this._parseRecordStream(records);
                    } else {
                        console.warn('[MostActiveClient] record-stream finished but 0 records');
                        // Still signal dual roster merger so it can proceed
                        if (this._dualRosterPending > 0) {
                            this._collectDualRoster([]);
                        }
                    }
                    return;
                }
            }

            // Fallback: any message with matching cmdid that looks like data
            if (msgCmdid === this._recordCmdid && ev !== 'res') {
                const payload = msg?.data?.data;
                if (payload !== undefined) {
                    this._recordBuffer.push(payload);
                    return;
                }
            }
        }

        // Handshake ack
        const rid = msg?.rid;
        if (rid !== undefined && rid !== null) {
            const entry = this._pendingRids.get(rid);
            this._pendingRids.delete(rid);
            const type = entry?.type ?? entry; // back-compat if plain string

            if (type === 'handshake') {
                console.log('[MostActiveClient] handshake OK — querying roster');
                this.queryRoster();
                return;
            }

            if (type === 'roster') {
                const holdCmdid = entry?.cmdid;
                const result = msg?.data?.data ?? msg?.data?.result ?? msg?.data;
                // Detect HOLD ("reply as record") → switch to record-streaming
                if (result?.status === 'HOLD' || result?.msg === 'reply as record') {
                    const cmdidForRecord = holdCmdid || this._rosterCmdidGain || this._rosterCmdidLoss;
                    console.log(`[MostActiveClient] HOLD received — waiting for record stream (cmdid=${cmdidForRecord})`);
                    this._recordCmdid = cmdidForRecord;
                    this._recordBuffer = [];
                    this._recordDebugCount = 0;
                    // Set a timeout: if no records arrive in 15s, give up and flush
                    clearTimeout(this._recordTimeout);
                    this._recordTimeout = setTimeout(() => {
                        if (this._recordCmdid !== null) {
                            console.warn(`[MostActiveClient] record-stream timeout! Got ${this._recordBuffer.length} records so far. Flushing.`);
                            const records = this._recordBuffer;
                            this._recordCmdid = null;
                            this._recordBuffer = [];
                            this._recordDebugCount = 0;
                            if (records.length) {
                                this._parseRecordStream(records);
                            } else if (this._dualRosterPending > 0) {
                                this._collectDualRoster([]);
                            }
                        }
                    }, 15000);
                    return;
                }
                if (result) this._parseRosterResult(result);
                return;
            }
        }

        // Push-style roster update (server-initiated, e.g. after subscribe)
        if (msg?.event === 'data' || msg?.event === 'cmd') {
            const d = msg?.data;
            if (d?.data?.rows || d?.result?.rows || d?.rows) {
                const result = d?.data ?? d?.result ?? d;
                this._parseRosterResult(result);
            }
        }
    }

    /**
     * Extract usable pipe-delimited string from a record payload.
     * IPOT record formats:
     *   1. Plain string:  "BBRI|Bank Rakyat|4530|..."
     *   2. Keyed object:  { xen_qu_top_stock_gl: "BBRI|Bank Rakyat|4530|..." }
     *   3. Record object: { rec: "ENZO|68|-12|-15.0|...", fieldnames: [...] }
     *   4. Array:         ["BBRI", "Bank Rakyat", 4530, ...]
     *   5. Named object:  { code: "BBRI", lp: 4530, ... }
     */
    _extractRecordLine(rec) {
        if (typeof rec === 'string') return rec;
        if (Array.isArray(rec)) return rec;
        if (rec && typeof rec === 'object') {
            // Record-streaming pattern: { rec: "ENZO|68|...", fieldnames: [...] }
            if (typeof rec.rec === 'string' && rec.rec.includes('|')) return rec.rec;
            // Keyed-object pattern: { index_name: "pipe|delimited|string" }
            const knownKeys = ['xen_qu_top_stock_gl', 'en_qu_top_stock', 'get_top_stock'];
            for (const k of knownKeys) {
                if (typeof rec[k] === 'string') return rec[k];
            }
            // Fallback: find any string value that looks like pipe-delimited data
            const vals = Object.values(rec);
            for (const v of vals) {
                if (typeof v === 'string' && v.includes('|')) return v;
            }
            // Could be a named-field object (e.g. { code: "BBRI", lp: 4530 })
            if (rec.code || rec.c || rec.stock_code) return rec;
        }
        return rec;
    }

    /**
     * Auto-detect column mapping from IPOT pipe-delimited rows.
     * Analyses the first few rows to determine which column index maps to
     * last_price, prev_close, change, change_pct, volume, value, freq.
     *
     * IPOT xen_qu_top_stock_gl may return 7-col or 13-col formats depending
     * on server version. This function handles both.
     */
    _detectColumnMapping(sampleRows, forceRedetect = false) {
        // Lock: reuse cached mapping once detected (IPOT column order is stable within a session)
        if (this._colMapping && !forceRedetect) {
            console.debug('[ColDetect] reusing cached mapping (locked)');
            return this._colMapping;
        }

        if (!sampleRows.length) return null;

        // Take up to 10 sample rows, convert to numeric arrays (skip first 2: code, name)
        const samples = sampleRows.slice(0, 10).map(row => {
            const arr = typeof row === 'string' ? row.split('|') : (Array.isArray(row) ? row : []);
            return arr.map((v, i) => ({ i, raw: v, n: Number(v) }));
        }).filter(r => r.length > 4);

        if (!samples.length) return null;
        const colCount = samples[0].length;

        // Log full column dump for diagnostics
        console.log(`[ColDetect] ${colCount} columns in record. First row dump:`);
        samples[0].forEach(c => {
            const numFlag = Number.isFinite(c.n) ? `num=${c.n}` : 'NaN';
            console.log(`  [${c.i}] "${String(c.raw).slice(0, 40)}" → ${numFlag}`);
        });

        // ── FAST PATH: Known 7-column IPOT format ──
        // xen_qu_top_stock_gl: code|name|last_price|value|volume|change_pct|freq
        // Confirmed by: query orderby=[[3,"ASC","N"]] (col3=value), sum=[6] (col6=freq)
        if (colCount === 7) {
            const mapping = {
                last_price: 2, prev_close: -1, change: -1, change_pct: 5,
                volume: 4, value: 3, freq: 6
            };
            // Validate: col3 (value) should be a very large positive number
            const valSample = samples[0][3]?.n;
            if (Number.isFinite(valSample) && valSample > 1e6) {
                console.log('[ColDetect] 7-col IPOT format detected (fast path):', JSON.stringify(mapping));
                this._colMapping = mapping;
                return mapping;
            }
            // Otherwise fall through to heuristic detection
            console.warn('[ColDetect] 7-col but col3 validation failed, falling back to heuristic');
        }

        // Skip first 2 columns (code, name) — all remaining should be numeric
        const numStart = 2;

        // Classify each numeric column across samples
        const colStats = [];
        for (let ci = numStart; ci < colCount; ci++) {
            const vals = samples.map(s => s[ci]?.n).filter(Number.isFinite);
            if (!vals.length) { colStats.push(null); continue; }
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const absMax = Math.max(Math.abs(min), Math.abs(max));
            const median = vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
            const allPositive = min >= 0;
            colStats.push({ ci, min, max, absMax, median, allPositive, count: vals.length });
        }

        // Heuristics for IDX stocks:
        // - price:      50 – 100,000 IDR, always positive
        // - change_abs: -2000 to +2000, can be negative
        // - change_pct: -35 to +35, typically -10 to +10, can be negative
        // - volume:     > 1000 (lots), positive
        // - value:      > 1,000,000 (IDR), positive, VERY large (biggest number)
        // - freq:       > 10, positive, smaller than volume

        const mapping = { last_price: -1, prev_close: -1, change: -1, change_pct: -1, volume: -1, value: -1, freq: -1 };

        // Find VALUE: the column with the largest median absolute value (usually > 1e9)
        let bestValue = null;
        for (const s of colStats) {
            if (!s || !s.allPositive) continue;
            if (!bestValue || s.median > bestValue.median) bestValue = s;
        }
        if (bestValue && bestValue.median > 1e6) {
            mapping.value = bestValue.ci;
        }

        // Find VOLUME: second largest positive column (but not as big as value)
        let bestVol = null;
        for (const s of colStats) {
            if (!s || s.ci === mapping.value || !s.allPositive) continue;
            if (s.median > 100 && (!bestVol || s.median > bestVol.median)) bestVol = s;
        }
        if (bestVol) mapping.volume = bestVol.ci;

        // Find FREQ: third largest positive column, smaller than volume
        let bestFreq = null;
        for (const s of colStats) {
            if (!s || s.ci === mapping.value || s.ci === mapping.volume || !s.allPositive) continue;
            if (s.median > 5 && (!bestFreq || s.median > bestFreq.median)) bestFreq = s;
        }
        if (bestFreq) mapping.freq = bestFreq.ci;

        // Find CHANGE_PCT: small numbers, can be negative, median abs typically < 20
        let bestPct = null;
        for (const s of colStats) {
            if (!s || s.ci === mapping.value || s.ci === mapping.volume || s.ci === mapping.freq) continue;
            if (s.absMax < 40 && Math.abs(s.median) < 25) {
                // Most likely candidate for percentage
                if (!bestPct || s.absMax < bestPct.absMax) bestPct = s;
            }
        }
        if (bestPct) mapping.change_pct = bestPct.ci;

        // Find CHANGE (absolute): small-ish numbers, can be negative, but larger abs than pct
        let bestChange = null;
        for (const s of colStats) {
            if (!s || [mapping.value, mapping.volume, mapping.freq, mapping.change_pct].includes(s.ci)) continue;
            if (!s.allPositive && s.absMax < 5000) {
                if (!bestChange || s.absMax < bestChange.absMax) bestChange = s;
            }
        }
        if (bestChange) mapping.change = bestChange.ci;

        // Find PRICE columns: positive, in range 50–100000, not already assigned
        const priceCandidates = [];
        for (const s of colStats) {
            if (!s || [mapping.value, mapping.volume, mapping.freq, mapping.change_pct, mapping.change].includes(s.ci)) continue;
            if (s.allPositive && s.median >= 50 && s.median <= 100000) {
                priceCandidates.push(s);
            }
        }
        // Sort by column index — earliest likely prev_close, next last_price
        priceCandidates.sort((a, b) => a.ci - b.ci);
        if (priceCandidates.length >= 2) {
            mapping.prev_close = priceCandidates[0].ci;
            mapping.last_price = priceCandidates[1].ci;
        } else if (priceCandidates.length === 1) {
            mapping.last_price = priceCandidates[0].ci;
        }

        // Validation: if change_pct wasn't found but change + last_price exist, we can compute it
        // If change_pct was found, verify it makes sense relative to price and change
        if (mapping.change_pct >= 0 && mapping.last_price >= 0 && mapping.change >= 0) {
            const samplePct = samples[0][mapping.change_pct]?.n ?? 0;
            const samplePrice = samples[0][mapping.last_price]?.n ?? 0;
            const sampleChange = samples[0][mapping.change]?.n ?? 0;
            if (samplePrice > 0 && Math.abs(sampleChange) > 0) {
                const computedPct = (sampleChange / (samplePrice - sampleChange)) * 100;
                // If detected pct is far from computed pct, it's probably wrong
                if (Math.abs(samplePct - computedPct) > 3) {
                    console.warn(`[ColDetect] change_pct col ${mapping.change_pct} (${samplePct}) doesn't match computed (${computedPct.toFixed(2)}) — will compute from change/price`);
                    mapping.change_pct = -1; // Mark as needing computation
                }
            }
        }

        console.log('[ColDetect] detected mapping:', JSON.stringify(mapping));

        // Validate: only cache if at least price and value were detected
        const essentialCount = [mapping.last_price, mapping.value, mapping.volume].filter(v => v >= 0).length;
        if (essentialCount >= 2) {
            this._colMapping = mapping;
            console.log('[ColDetect] mapping locked (essential cols:', essentialCount, '/ 3)');
        } else {
            console.warn('[ColDetect] mapping NOT locked — only', essentialCount, 'essential columns detected');
        }
        return mapping;
    }

    /**
     * Parse a single row using detected or fallback column mapping.
     */
    _parseRowWithMapping(row, idx, mapping) {
        const isArr = Array.isArray(row);
        const get = (ci) => {
            if (ci < 0) return undefined;
            return Number(isArr ? row[ci] : undefined) || 0;
        };

        const code = String((isArr ? row[0] : (row.c ?? row.code ?? row.stock_code ?? '')) || '').trim().toUpperCase();

        let last_price = get(mapping.last_price);
        let value = get(mapping.value);
        let volume = get(mapping.volume);
        let freq = get(mapping.freq);
        let prev_close = get(mapping.prev_close);
        let change_pct = mapping.change_pct >= 0 ? get(mapping.change_pct) : undefined;

        // If change_pct not detected, compute from change + price
        if (change_pct === undefined && mapping.change >= 0 && last_price > 0) {
            const change = get(mapping.change);
            const prev = last_price - change;
            change_pct = prev > 0 ? (change / prev) * 100 : 0;
        }
        // Fallback: compute from prev_close + last_price (most reliable)
        if (change_pct === undefined && prev_close > 0 && last_price > 0) {
            change_pct = ((last_price - prev_close) / prev_close) * 100;
        }
        // Cross-validate: if prev_close available and detected pct looks wrong, recompute
        if (change_pct !== undefined && prev_close > 0 && last_price > 0) {
            const computedPct = ((last_price - prev_close) / prev_close) * 100;
            if (Math.abs(change_pct - computedPct) > 3) {
                change_pct = computedPct;
            }
        }
        // Last fallback: if still undefined, try index 5
        if (change_pct === undefined) {
            change_pct = Number(isArr ? row[5] : 0) || 0;
        }

        // Named-object fallback (non-array rows)
        if (!isArr && typeof row === 'object') {
            return {
                code: code || String(row.c ?? row.code ?? row.stock_code ?? '').trim().toUpperCase(),
                rank: idx + 1,
                last_price: Number(row.lp ?? row.last_price ?? row.close ?? last_price) || 0,
                value: Number(row.v ?? row.value ?? value) || 0,
                volume: Number(row.vl ?? row.volume ?? volume) || 0,
                change_pct: Number(row.cp ?? row.change_pct ?? row.pct ?? change_pct) || 0,
                freq: Number(row.fr ?? row.freq ?? freq) || 0,
            };
        }

        return {
            code,
            rank: idx + 1,
            last_price,
            value,
            volume,
            change_pct: Number(change_pct) || 0,
            freq,
        };
    }

    /**
     * Build column mapping from IPOT fieldnames array.
     * Example fieldnames: ["sec","p_close","chg","pchg","pfh","pfl","tval","tvol","avg"]
     * Despite the name "p_close", it is the LAST/current price (verified against IPOT UI).
     */
    _buildMappingFromFieldnames(fieldnames) {
        if (!Array.isArray(fieldnames) || fieldnames.length < 3) return null;
        const idx = (name) => fieldnames.indexOf(name);
        const firstOf = (...names) => {
            for (const n of names) { const i = idx(n); if (i >= 0) return i; }
            return -1;
        };
        const mapping = {
            last_price:  firstOf('p_close', 'last', 'close', 'last_price'),
            prev_close:  -1, // not directly in record; compute from last_price - change
            change:      firstOf('chg', 'change'),
            change_pct:  firstOf('pchg', 'change_pct', 'pct'),
            value:       firstOf('tval', 'value', 'val'),
            volume:      firstOf('tvol', 'volume', 'vol'),
            freq:        firstOf('freq', 'nf'),
        };
        // Validate: at least last_price and value must be found
        if (mapping.last_price < 0 && mapping.value < 0) return null;
        return mapping;
    }

    /**
     * Parse records from IPOT record-streaming (HOLD pattern).
     * Each record may be: pipe-delimited string, keyed object, array, or named object.
     * First record often includes `fieldnames` array for explicit column mapping.
     */
    _parseRecordStream(records) {
        if (!records.length) return;

        // Phase 0: Extract fieldnames from first record (IPOT provides column names)
        let fieldnamesMapping = null;
        for (const rec of records) {
            if (rec && typeof rec === 'object' && Array.isArray(rec.fieldnames)) {
                fieldnamesMapping = this._buildMappingFromFieldnames(rec.fieldnames);
                if (fieldnamesMapping) {
                    console.log('[ColDetect] fieldnames found:', JSON.stringify(rec.fieldnames));
                    console.log('[ColDetect] fieldnames-based mapping:', JSON.stringify(fieldnamesMapping));
                }
                break;
            }
        }

        // Extract all rows
        const rows = records.map(rec => {
            let row = this._extractRecordLine(rec);
            if (typeof row === 'string') row = row.split('|');
            return row;
        });

        // Use fieldnames mapping (authoritative), otherwise detect heuristically
        let mapping;
        if (fieldnamesMapping) {
            this._colMapping = fieldnamesMapping;
            mapping = fieldnamesMapping;
        } else {
            const arrayRows = rows.filter(Array.isArray);
            mapping = this._detectColumnMapping(arrayRows) ?? this._colMapping;
        }

        if (!mapping) {
            console.warn('[MostActiveClient] could not detect column mapping, using fallback indices');
        }

        console.debug('[MostActiveClient] record-stream raw[0]:', JSON.stringify(records[0]));

        const parsed = rows.map((row, idx) => {
            const isArr = Array.isArray(row);
            if (!isArr && typeof row !== 'object') {
                console.debug('[MostActiveClient] skipping unparseable record:', records[idx]);
                return null;
            }

            if (mapping && isArr) {
                return this._parseRowWithMapping(row, idx, mapping);
            }

            // Fallback: original hardcoded indices
            const code = String((isArr ? row[0] : (row.c ?? row.code ?? row.stock_code ?? '')) || '').trim().toUpperCase();
            return {
                code,
                rank:        idx + 1,
                last_price:  Number(isArr ? row[2] : (row.lp ?? row.last_price ?? row.close ?? 0)) || 0,
                value:       Number(isArr ? row[3] : (row.v  ?? row.value ?? 0)) || 0,
                volume:      Number(isArr ? row[4] : (row.vl ?? row.volume ?? 0)) || 0,
                change_pct:  Number(isArr ? row[5] : (row.cp ?? row.change_pct ?? row.pct ?? 0)) || 0,
                freq:        Number(isArr ? row[6] : (row.fr ?? row.freq ?? 0)) || 0,
            };
        }).filter(r => r && r.code && /^[A-Z]{2,6}$/.test(r.code));

        // Debug: log first 3 parsed results
        if (parsed.length) {
            console.log(`[MostActiveClient] record-stream parsed: ${parsed.length} symbols. Samples:`);
            parsed.slice(0, 3).forEach(r => console.log(`  ${r.code}: price=${r.last_price}, chg=${r.change_pct?.toFixed(2)}%, val=${r.value}, vol=${r.volume}, freq=${r.freq}`));
            // Route through dual G/L merger if active, otherwise direct
            if (this._dualRosterPending > 0) {
                this._collectDualRoster(parsed);
            } else {
                this._onRoster(parsed);
            }
        } else {
            console.warn('[MostActiveClient] record-stream parsed 0 valid symbols from', records.length, 'records. Raw samples:', records.slice(0, 3));
            // Still decrement dual roster pending if active
            if (this._dualRosterPending > 0) {
                this._collectDualRoster([]);
            }
        }
    }

    _parseRosterResult(result) {
        // IPOT result can be { rows: [...], total: N } or { data: { rows: [...] } }
        const rows = result?.rows ?? result?.data?.rows ?? [];
        if (!Array.isArray(rows) || !rows.length) {
            console.warn('[MostActiveClient] roster result empty or unrecognised format', result);
            return;
        }

        // Log raw first row for column-mapping validation
        console.debug('[MostActiveClient] roster raw row[0]:', rows[0]);

        // Detect column mapping (for array rows)
        const arrayRows = rows.filter(Array.isArray);
        const mapping = (arrayRows.length ? this._detectColumnMapping(arrayRows) : null) ?? this._colMapping;

        const parsed = rows.map((row, idx) => {
            const isArr = Array.isArray(row);

            if (mapping && isArr) {
                return this._parseRowWithMapping(row, idx, mapping);
            }

            // Fallback: original indices or keyed object
            return {
                code:        String((isArr ? row[0] : (row.c ?? row.code ?? row[0])) || '').trim().toUpperCase(),
                rank:        idx + 1,
                last_price:  Number(isArr ? row[2] : (row.lp ?? row.last_price ?? row[2])) || 0,
                value:       Number(isArr ? row[3] : (row.v  ?? row.value       ?? row[3])) || 0,
                volume:      Number(isArr ? row[4] : (row.vl ?? row.volume      ?? row[4])) || 0,
                change_pct:  Number(isArr ? row[5] : (row.cp ?? row.change_pct  ?? row[5])) || 0,
                freq:        Number(isArr ? row[6] : (row.fr ?? row.freq        ?? row[6])) || 0,
            };
        }).filter(r => r.code && /^[A-Z]{2,6}$/.test(r.code));

        if (parsed.length) {
            console.log(`[MostActiveClient] roster parsed: ${parsed.length} symbols. Samples:`);
            parsed.slice(0, 3).forEach(r => console.log(`  ${r.code}: price=${r.last_price}, chg=${r.change_pct?.toFixed(2)}%, val=${r.value}, vol=${r.volume}, freq=${r.freq}`));
        }
        // Route through dual G/L merger if active, otherwise direct
        if (this._dualRosterPending > 0) {
            this._collectDualRoster(parsed);
        } else {
            this._onRoster(parsed);
        }
    }

    _onClose(e) {
        console.warn('[MostActiveClient] WS closed', e.code, e.reason);
        this._connected = false;
        this._onStatus('DEGRADED');
        this._cleanup();
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this._destroyed || this._reconnectTimer) return;
        console.log(`[MostActiveClient] reconnect in ${this._reconnectDelay}ms`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
    }

    _cleanup() {
        if (this._pingTimer)      { clearInterval(this._pingTimer);    this._pingTimer = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._recordTimeout)  { clearTimeout(this._recordTimeout);  this._recordTimeout = null; }
        if (this._ws) {
            try { this._ws.close(); } catch {}
            this._ws = null;
        }
        this._connected = false;
        // Reset record-streaming state
        this._recordCmdid = null;
        this._recordBuffer = [];
        this._recordDebugCount = 0;
    }
}

// ============================================================
// 6. ORDERBOOK CLIENT  (FR-3, P0)
// Subscribe / maintain / unsubscribe OB2 for top-N symbols.
// Uses the SAME WS connection via sendFn.
// ============================================================
class OrderbookClient {
    /**
     * @param {object}   opts
     * @param {function} opts.onOb2Update  callback(code, indicator)
     */
    constructor({ onOb2Update }) {
        this._onOb2Update = onOb2Update || (() => {});
        // code → { subsid: string, gracePeriodExpiry: number|null }
        this._subscriptions = new Map();
        this._gracePeriodMs = 3 * 60 * 1000; // 3 minutes
        this._cid = 500;
    }

    _nextCid() { return ++this._cid; }

    _genSubsid() {
        return Math.random().toString(36).slice(2, 12);
    }

    /**
     * Reconcile subscriptions with current roster list.
     * ACCUMULATE-ONLY: never unsubscribes during the session.
     * All symbols that ever appeared in the roster stay subscribed
     * so BSS/ATS data keeps flowing for the full trading day.
     * Subscriptions naturally reset on page reload / WS reconnect.
     */
    reconcile(topNCodes, sendFn) {
        // Subscribe new entrants only — never unsubscribe
        for (const code of topNCodes) {
            if (!this._subscriptions.has(code)) {
                this._subscribeSymbol(code, sendFn);
            }
        }
    }

    _subscribeSymbol(code, sendFn) {
        const subsid = this._genSubsid();
        this._subscriptions.set(code, { subsid, gracePeriodExpiry: null });
        const cid = this._nextCid();
        // Match server-side format (livetrade-taping) — include level:10 for depth
        sendFn({
            event: 'cmd',
            data: {
                cmdid: 248,
                param: { cmd: 'subscribe', service: 'mi', code, level: 10, subsid, rtype: 'OB2' }
            },
            cid
        });
        console.log(`[OrderbookClient] subscribed ${code} subsid=${subsid} cid=${cid}`);
    }

    _unsubscribeSymbol(code, sendFn) {
        const entry = this._subscriptions.get(code);
        if (!entry) return;
        const cid = this._nextCid();
        sendFn({
            event: 'cmd',
            data: {
                cmdid: 248,
                param: { cmd: 'unsubscribe', service: 'mi', code, subsid: entry.subsid, rtype: 'OB2' }
            },
            cid
        });
        this._subscriptions.delete(code);
        console.log(`[OrderbookClient] unsubscribed ${code}`);
    }

    /**
     * Handle an incoming WS message. If it's an OB2 update, feed it to scoreEngine.
     * IPOT sends OB2 via event: "stream" or "#publish" (NOT "data").
     */
    handleMessage(msg, scoreEngine) {
        // OB2 arrives as:
        //   { event: 'stream',   data: { rtype:'OB2', code:'BUVA', bid:[[p,q],...], ask:[[p,q],...] } }
        //   { event: '#publish', data: { rtype:'OB2', code:'BUVA', data:{ bid, ask } } }
        //   { event: '#publish', data: { channel:'mi.ob2.BUVA', data:{ bid, ask } } }
        //   { event: 'data',    data: { service:'mi', code:'BUVA', rtype:'OB2', data:{bid,ask} } }
        const ev = msg?.event;
        if (ev !== 'stream' && ev !== '#publish' && ev !== 'data' && ev !== 'cmd') return;

        const d = msg?.data;
        if (!d) return;

        // Unwrap nested data (could be d.data or d.result or d itself)
        const inner = d?.data ?? d?.result ?? d;

        // Extract rtype from multiple possible locations
        let rtype = String(inner?.rtype ?? d?.rtype ?? '').toUpperCase();

        // Fallback: detect OB2 from channel name (e.g. 'mi.ob2.BBRI', 'ob2/BBRI')
        const channel = String(d?.channel ?? '').toLowerCase();
        if (rtype !== 'OB2' && channel.includes('ob2')) rtype = 'OB2';

        if (rtype !== 'OB2') return;

        // Extract code — also from channel pattern like 'mi.ob2.BBRI'
        let code = String(inner?.code ?? d?.code ?? '').toUpperCase();
        if (!code && channel) {
            const m = channel.match(/ob2[./]([a-z]{2,6})/i);
            if (m) code = m[1].toUpperCase();
        }
        if (!code || !this._subscriptions.has(code)) return;

        // Extract bid/ask — use _extractOB2Sides for robust parsing
        const { bid, ask } = OrderbookClient._extractOB2Sides(msg);

        if (!bid.length || !ask.length) return;

        // Debug: log first OB2 update per symbol
        if (!this._ob2DebugSeen) this._ob2DebugSeen = new Set();
        if (!this._ob2DebugSeen.has(code)) {
            this._ob2DebugSeen.add(code);
            console.log(`[OrderbookClient] first OB2 data for ${code}: bid[0]=${JSON.stringify(bid[0])}, ask[0]=${JSON.stringify(ask[0])}, levels: bid=${bid.length} ask=${ask.length}`);
        }

        scoreEngine.pushOb2(code, bid, ask);
        const indicator = scoreEngine.getOb2Indicator(code);
        this._onOb2Update(code, indicator);
    }

    /**
     * Robust extractor for bid/ask arrays from any IPOT OB2 message format.
     * Handles: bid/ask keys, BUY/SELL keys (INIT snapshot), recinfo pipe-delimited (UPDATE),
     * and nested JSON-string data payloads.
     * Returns { bid: [[price,qty],...], ask: [[price,qty],...] }
     */
    static _extractOB2Sides(msg) {
        const d = msg?.data;
        const inner = d?.data ?? d?.result ?? d;

        // Helper: try extracting from an object
        const tryObj = (o) => {
            if (!o || typeof o !== 'object') return { bid: [], ask: [] };
            // Standard keys: bid/ask
            let bid = Array.isArray(o.bid) ? o.bid : [];
            let ask = Array.isArray(o.ask) ? o.ask : [];
            // IPOT INIT snapshot keys: BUY/SELL
            if (!bid.length && Array.isArray(o.BUY))  bid = o.BUY;
            if (!ask.length && Array.isArray(o.SELL)) ask = o.SELL;
            return { bid, ask };
        };

        // 1. Try direct extraction from inner payload
        let { bid, ask } = tryObj(inner);

        // 2. Try from d level
        if (!bid.length || !ask.length) {
            const fromD = tryObj(d);
            if (!bid.length) bid = fromD.bid;
            if (!ask.length) ask = fromD.ask;
        }

        // 3. If inner has nested data object
        if ((!bid.length || !ask.length) && inner?.data && typeof inner.data === 'object') {
            const fromNested = tryObj(inner.data);
            if (!bid.length) bid = fromNested.bid;
            if (!ask.length) ask = fromNested.ask;
        }

        // 4. If data is a JSON string (IPOT sends stringified OB2 payloads)
        const strPayload = typeof d?.data === 'string' ? d.data
                         : typeof inner?.data === 'string' ? inner.data
                         : null;
        if ((!bid.length || !ask.length) && strPayload) {
            try {
                const parsed = JSON.parse(strPayload);
                const fromParsed = tryObj(parsed);
                if (!bid.length) bid = fromParsed.bid;
                if (!ask.length) ask = fromParsed.ask;

                // IPOT UPDATE format: recinfo pipe-delimited string
                if ((!bid.length || !ask.length) && typeof parsed?.recinfo === 'string') {
                    const extracted = OrderbookClient._parseRecinfo(parsed.recinfo);
                    if (!bid.length) bid = extracted.bid;
                    if (!ask.length) ask = extracted.ask;
                }
            } catch { /* ignore parse errors */ }
        }

        // 5. Direct recinfo on inner object
        if ((!bid.length || !ask.length) && typeof inner?.recinfo === 'string') {
            const extracted = OrderbookClient._parseRecinfo(inner.recinfo);
            if (!bid.length) bid = extracted.bid;
            if (!ask.length) ask = extracted.ask;
        }

        return { bid, ask };
    }

    /**
     * Parse IPOT recinfo pipe-delimited OB2 UPDATE format.
     * Format: "header|;|bestBid|bestAsk|?|price|bidVol|askVol|price|bidVol|askVol|..."
     * Returns { bid: [[price,qty],...], ask: [[price,qty],...] }
     */
    static _parseRecinfo(recinfo) {
        const bid = [], ask = [];
        try {
            // Split header from depth data
            const depthPart = recinfo.includes('|;|') ? recinfo.split('|;|')[1] : recinfo;
            if (!depthPart) return { bid, ask };
            const parts = depthPart.split('|');
            // Skip first 3 fields (bestBid, bestAsk, unknown), then triplets
            for (let i = 3; i + 2 < parts.length; i += 3) {
                const price  = Number(parts[i]) || 0;
                const bidVol = parseInt(parts[i + 1], 10) || 0;
                const askVol = parseInt(parts[i + 2], 10) || 0;
                if (price > 0) {
                    if (bidVol > 0) bid.push([price, bidVol]);
                    if (askVol > 0) ask.push([price, askVol]);
                }
            }
            // Sort: bids descending by price, asks ascending by price
            bid.sort((a, b) => b[0] - a[0]);
            ask.sort((a, b) => a[0] - b[0]);
        } catch { /* ignore parse errors */ }
        return { bid, ask };
    }

    getSubscribedCodes() { return [...this._subscriptions.keys()]; }

    unsubscribeAll(sendFn) {
        for (const [code] of this._subscriptions) {
            this._unsubscribeSymbol(code, sendFn);
        }
    }
}

// ============================================================
// 7. MOST ACTIVE ORCHESTRATOR
// Ties all components together. Drives the minute + micro ticks.
// ============================================================
class MostActiveOrchestrator {
    /**
     * @param {object}   opts
     * @param {string}   opts.wsUrl    Full wss:// URL with appsession token
     * @param {number}   [opts.topN=10]
     * @param {function} opts.onUpdate callback({ type:'minute'|'micro', rows, ts })
     * @param {function} opts.onStatus callback('LIVE'|'DEGRADED'|'STALE')
     */
    constructor({ wsUrl, topN = 10, onUpdate, onStatus }) {
        this._topN = topN;
        this._onUpdate = onUpdate || (() => {});
        this._onStatus = onStatus || (() => {});

        this._trailStore = new RankTrailStore(60);
        this._scoreEngine = new HotScoreEngine(this._trailStore);
        this._currentRoster = [];
        this._topNCodes = [];
        this._lastSuccessTs = 0;
        this._seedDone = false; // Phase 2: track if OB2 seed has been fetched

        // External data provider — set by host page (idx/index.html) to supply
        // footprint + sector CVD data that lives outside the pipeline module.
        // Signature: (code) => { cvd, div_detected, div_score, div_type, chg_pct } | null
        this._externalDataProvider = null;

        // Restore intraday trails from localStorage (survives page refresh)
        const restoredRank = this._trailStore.restoreFromLocalStorage();
        const restoredPI   = this._scoreEngine.restorePressureTrailFromLocalStorage();
        const restoredCVD  = this._scoreEngine.restoreCvdTrailFromLocalStorage();
        if (restoredRank || restoredPI || restoredCVD) {
            console.log(`[Orchestrator] restored from cache: ${restoredRank} rank, ${restoredPI} pressure, ${restoredCVD} CVD trails`);
        }

        // Restore cached roster snapshot for instant render (before WS connects)
        this._restoreRosterFromLocalStorage();

        this._obClient = new OrderbookClient({
            onOb2Update: (code, indicator) => this._handleOb2Update(code, indicator)
        });

        this._client = new MostActiveClient({
            wsUrl,
            onRoster:    (rows) => this._handleRoster(rows),
            onAnyMessage: (msg) => this._obClient.handleMessage(msg, this._scoreEngine),
            onStatus:    (s) => this._onStatus(s)
        });

        this._minuteTimer = null;
        this._microTimer  = null;
        this._staleTimer  = null;
    }

    start() {
        this._client.connect();

        // 60s roster refresh
        this._minuteTimer = setInterval(() => {
            this._client.queryRoster();
        }, 60000);

        // 5s micro update (OB2 bars only)
        this._microTimer = setInterval(() => {
            this._publishMicroUpdate();
        }, 5000);

        // Stale detector
        this._staleTimer = setInterval(() => {
            if (this._lastSuccessTs && Date.now() - this._lastSuccessTs > 90000) {
                this._onStatus('STALE');
            }
        }, 10000);

        // Persist trails to localStorage every 30s (intraday survival)
        this._persistTimer = setInterval(() => this._saveTrailsToLocalStorage(), 30000);

        // Also save before page unload
        this._beforeUnloadHandler = () => this._saveTrailsToLocalStorage();
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
    }

    stop() {
        clearInterval(this._minuteTimer);
        clearInterval(this._microTimer);
        clearInterval(this._staleTimer);
        clearInterval(this._persistTimer);
        window.removeEventListener('beforeunload', this._beforeUnloadHandler);
        this._saveTrailsToLocalStorage();
        this._obClient.unsubscribeAll((msg) => this._client.send(msg));
        this._client.destroy();
    }

    /** Persist rank trail + pressure trail + CVD trail + roster snapshot to localStorage */
    _saveTrailsToLocalStorage() {
        this._trailStore.saveToLocalStorage();
        this._scoreEngine.savePressureTrailToLocalStorage();
        this._scoreEngine.saveCvdTrailToLocalStorage();
        this._saveRosterToLocalStorage();
    }

    // ---- Roster snapshot localStorage cache (instant render on page load) ----
    static _ROSTER_LS_KEY = 'ma_roster_snapshot_v1';

    _saveRosterToLocalStorage() {
        if (!this._currentRoster.length) return;
        try {
            const slim = this._currentRoster.map(r => ({
                code: r.code,
                rank_now: r.rank_now,
                last_price: r.last_price,
                value: r.value,
                volume: r.volume,
                change_pct: r.change_pct,
                freq: r.freq,
                stage_score: r.stage_score,
                stage_label: r.stage_label,
            }));
            localStorage.setItem(MostActiveOrchestrator._ROSTER_LS_KEY, JSON.stringify({
                ts: Date.now(),
                date: new Date().toISOString().slice(0, 10),
                rows: slim,
            }));
        } catch (e) { /* quota exceeded — non-fatal */ }
    }

    _restoreRosterFromLocalStorage() {
        try {
            const raw = localStorage.getItem(MostActiveOrchestrator._ROSTER_LS_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            if (!obj?.rows?.length || !obj.date) return;
            const today = new Date().toISOString().slice(0, 10);
            if (obj.date !== today) {
                localStorage.removeItem(MostActiveOrchestrator._ROSTER_LS_KEY);
                console.log('[Orchestrator] discarding stale roster cache from', obj.date);
                return;
            }
            // Rebuild full snapshot rows from slim cache + restored trails
            const maxRank = obj.rows.length;
            this._currentRoster = obj.rows.map(r => ({
                code: r.code,
                rank_now: r.rank_now,
                rank_delta_5m: this._trailStore.getRankDelta(r.code, 5),
                rank_delta_15m: this._trailStore.getRankDelta(r.code, 15),
                rank_trail: [...this._trailStore.getTrail(r.code)],
                pressure_trail: this._scoreEngine.getPressureTrail(r.code),
                ob2_indicator: this._scoreEngine.getOb2Indicator(r.code),
                stage_score: r.stage_score ?? 0,
                stage_label: r.stage_label ?? 'Cooling',
                reason_codes: [],
                components: {},
                risk_memory_missing: true,
                last_price: r.last_price,
                value: r.value,
                volume: r.volume,
                change_pct: r.change_pct,
                freq: r.freq,
            }));
            this._lastSuccessTs = obj.ts;
            this._topNCodes = this._currentRoster.slice(0, this._topN).map(r => r.code);
            console.log(`[Orchestrator] restored ${this._currentRoster.length} roster rows from cache (${Math.round((Date.now() - obj.ts) / 1000)}s old)`);
            // Emit immediately so table renders before WS connects
            this._onUpdate({ type: 'minute', rows: this._currentRoster, ts: obj.ts });
        } catch (e) {
            console.warn('[Orchestrator] roster cache restore failed:', e);
        }
    }

    getCurrentRoster() { return [...this._currentRoster]; }

    /** Debug helper — call from console: _rosterOrchestrator.debugOb2() */
    debugOb2() {
        const subs = this._obClient.getSubscribedCodes();
        console.group('[OB2 Debug]');
        console.log('Subscribed symbols:', subs);
        subs.forEach(code => {
            const ind = this._scoreEngine.getOb2Indicator(code);
            const ob2 = this._scoreEngine._ob2.get(code);
            console.log(`  ${code}: bss=${ind.bss} ats=${ind.ats} missing=${ind.missing} updates=${ob2?.updateCount ?? 0} bufLen=${ob2?._buf?.length ?? 0}`);
        });
        console.log('TopN codes:', this._topNCodes);
        console.groupEnd();
        return { subscribed: subs, topN: this._topNCodes };
    }

    /** Debug helper — call from console: _rosterOrchestrator.debugMapping() */
    debugMapping() {
        const mapping = this._client._colMapping;
        const roster = this._currentRoster.slice(0, 5);
        console.group('[Column Mapping Debug]');
        console.log('Detected mapping:', mapping);
        console.log('First 5 roster rows:');
        roster.forEach(r => {
            console.log(`  ${r.code}: price=${r.last_price}, chg%=${r.change_pct?.toFixed(2)}, val=${r.value}, vol=${r.volume}, freq=${r.freq}`);
        });
        console.groupEnd();
        return { mapping, roster };
    }

    /**
     * Debug helper — force re-detect column mapping on next roster refresh.
     * Call from console: _rosterOrchestrator.resetMapping()
     */
    resetMapping() {
        this._client._colMapping = null;
        console.log('[Orchestrator] column mapping cleared — will re-detect on next roster refresh');
    }

    // ---- private ----

    _handleRoster(rawRows) {
        this._lastSuccessTs = Date.now();
        const minuteKey = new Date().toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:mm'
        const maxRank = rawRows.length;

        // Update trail store
        const activeSet = new Set(rawRows.map(r => r.code));
        this._trailStore.expireAbsent(activeSet, minuteKey);
        rawRows.forEach(r => {
            this._trailStore.update(r.code, r.rank, minuteKey);
            this._scoreEngine.pushRosterRow(r.code, r.value, r.volume);
        });

        // Inject external data (footprint, sector CVD) into engine
        this._injectExternalData(rawRows);

        // Reconcile OB2 for ALL roster symbols (live WS subscriptions)
        const allCodes = rawRows.map(r => r.code);
        this._topNCodes = rawRows.slice(0, this._topN).map(r => r.code);
        this._obClient.reconcile(allCodes, (msg) => this._client.send(msg));

        // Phase 2: Seed OB2 from R2 on first roster arrival (all symbols, not just topN)
        if (!this._seedDone) {
            this._seedDone = true;
            this._seedOb2FromR2(rawRows.map(r => r.code)).then(() => {
                // Re-build snapshots with seeded OB2 data and trigger re-render
                if (this._currentRoster.length) {
                    this._rebatchScore();
                    console.log('[Orchestrator] re-rendering after OB2 seed');
                    this._onUpdate({ type: 'minute', rows: this._currentRoster, ts: this._lastSuccessTs });
                }
            });
        }

        // Build snapshot with batch scoring
        this._currentRoster = rawRows.map(r => this._buildSnapshot(r, maxRank));
        this._rebatchScore();
        this._onUpdate({ type: 'minute', rows: this._currentRoster, ts: this._lastSuccessTs });

        // Phase 1: Sync roster symbols to server for R2 OB2 coverage
        this._syncWatchlistToServer(rawRows.map(r => r.code));

        // Persist trails after each minute tick
        this._saveTrailsToLocalStorage();

        console.log(`[Orchestrator] minute tick: ${rawRows.length} rows, topN: [${this._topNCodes.join(',')}]`);
    }

    _handleOb2Update(code, indicator) {
        const row = this._currentRoster.find(r => r.code === code);
        if (!row) return;
        row.ob2_indicator = indicator;
        // Debounce re-batch score — during OB2 seed many symbols update in quick
        // succession; coalesce into a single batch recompute after 200ms of quiet
        if (this._ob2ScoreDebounce) clearTimeout(this._ob2ScoreDebounce);
        this._ob2ScoreDebounce = setTimeout(() => {
            this._ob2ScoreDebounce = null;
            this._rebatchScore();
        }, 200);
    }

    /**
     * Re-compute v2 scores for the full current roster (batch).
     * Called on minute tick, OB2 update, and OB2 seed completion.
     */
    _rebatchScore() {
        if (!this._currentRoster.length) return;
        const ctx = this._currentRoster.map(r => {
            // Use IPOT chg_pct if available; fall back to external data provider
            // so M percentile matches the displayed CHG% column
            let chg = r.change_pct ?? 0;
            if (chg === 0) {
                const ext = this._scoreEngine._externalData.get(r.code);
                if (ext?.chg_pct) chg = ext.chg_pct;
            }
            return {
                code: r.code,
                rank: r.rank_now,
                maxRank: this._currentRoster.length,
                chg_pct: chg,
                value: r.value ?? 0
            };
        });
        const results = this._scoreEngine.batchComputeV2(ctx);
        for (const row of this._currentRoster) {
            const s = results.get(row.code);
            if (!s) continue;
            row.stage_score  = s.stage_score;
            row.stage_label  = s.stage_label;
            row.reason_codes = s.reason_codes;
            row.components   = s.components;
        }
    }

    /**
     * Inject external data (footprint, sector CVD) into engine.
     * Called from host page via setExternalDataProvider().
     */
    _injectExternalData(rawRows) {
        if (!this._externalDataProvider) return;
        for (const r of rawRows) {
            const ext = this._externalDataProvider(r.code);
            if (ext) {
                this._scoreEngine.setExternalData(r.code, ext);
                // Push CVD into trail for slope computation
                if (ext.cvd != null) {
                    this._scoreEngine.pushCvdTick(r.code, ext.cvd);
                }
            }
        }
    }

    /** Set external data provider — called by host page (idx/index.html). */
    setExternalDataProvider(fn) {
        this._externalDataProvider = fn;
    }

    _buildSnapshot(rosterRow, maxRank) {
        const code = rosterRow.code;
        const trail = this._trailStore.getTrail(code);
        const ob2   = this._scoreEngine.getOb2Indicator(code);
        // Score is computed in batch by _rebatchScore(); populated after build
        return {
            code,
            rank_now:      rosterRow.rank,
            rank_delta_5m:  this._trailStore.getRankDelta(code, 5),
            rank_delta_15m: this._trailStore.getRankDelta(code, 15),
            rank_trail:    [...trail],
            pressure_trail: this._scoreEngine.getPressureTrail(code),
            ob2_indicator: ob2,
            stage_score:   0,   // filled by _rebatchScore()
            stage_label:   'Cooling',
            reason_codes:  [],
            components:    {},
            risk_memory_missing: true,   // FR-9 deferred
            // From roster
            last_price:  rosterRow.last_price,
            value:       rosterRow.value,
            volume:      rosterRow.volume,
            change_pct:  rosterRow.change_pct,
            freq:        rosterRow.freq,
        };
    }

    _publishMicroUpdate() {
        if (!this._currentRoster.length) return;
        // Refresh OB2 indicators + pressure trail for ALL roster rows
        this._currentRoster.forEach(row => {
            row.ob2_indicator = this._scoreEngine.getOb2Indicator(row.code);
            this._scoreEngine.pushPressureTick(row.code);
            row.pressure_trail = this._scoreEngine.getPressureTrail(row.code);
        });
        // Re-batch score with updated pressure data
        this._rebatchScore();
        this._onUpdate({ type: 'micro', rows: this._currentRoster, ts: Date.now() });
    }

    /**
     * Phase 1: POST dynamic watchlist to server so livetrade-taping
     * subscribes OB2 for all Most Active symbols (not just LQ45/IDX30).
     * Fire-and-forget — failure does not block the pipeline.
     */
    _syncWatchlistToServer(allCodes) {
        const workerBase = window.WORKER_BASE_URL ?? 'https://api-saham.mkemalw.workers.dev';
        try {
            fetch(`${workerBase}/ma-watchlist-sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: allCodes, source: 'browser', ts: Date.now() }),
                signal: AbortSignal.timeout(5000)
            }).then(resp => {
                if (!resp.ok) console.warn('[Orchestrator] watchlist sync failed:', resp.status);
                else console.debug('[Orchestrator] watchlist synced:', allCodes.length, 'symbols');
            }).catch(err => {
                console.warn('[Orchestrator] watchlist sync error:', err.message);
            });
        } catch (e) {
            // Fire-and-forget
        }
    }

    /**
     * Phase 2: Seed OB2 metrics from R2 snapshots for cold-start.
     * Fetches recent 15s snapshots and feeds them into Ob2RollingMetrics
     * so BSS/ATS are non-50/50 immediately on page load.
     * Batches requests (API caps at 20 symbols per call).
     */
    async _seedOb2FromR2(symbols) {
        if (!symbols.length) return;
        const workerBase = window.WORKER_BASE_URL ?? 'https://api-saham.mkemalw.workers.dev';
        const BATCH_SIZE = 20;
        let totalPushed = 0;
        let totalSymbols = 0;
        let allMissing = [];

        // Split into batches of 20
        const batches = [];
        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            batches.push(symbols.slice(i, i + BATCH_SIZE));
        }

        // Fetch all batches in parallel
        const results = await Promise.allSettled(batches.map(async (batch) => {
            const resp = await fetch(
                `${workerBase}/ob2-seed?symbols=${batch.join(',')}&count=30`,
                { signal: AbortSignal.timeout(8000) }
            );
            if (!resp.ok) return null;
            return resp.json();
        }));

        for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const data = result.value;
            const seeds = data?.seeds || {};

            for (const [code, snapshots] of Object.entries(seeds)) {
                if (!Array.isArray(snapshots)) continue;
                for (const snap of snapshots) {
                    // R2 snapshots may use bid/ask or bid_l10/ask_l10 keys
                    const bid = snap.bid || snap.bid_l10 || snap.BUY || [];
                    const ask = snap.ask || snap.ask_l10 || snap.SELL || [];
                    if (bid.length && ask.length) {
                        this._scoreEngine.pushOb2(code, bid, ask);
                        totalPushed++;
                    }
                }
                totalSymbols++;
            }
            allMissing.push(...(data?.coverage?.missing || []));
        }

        console.log(
            `[OB2-Seed] seeded ${totalSymbols}/${symbols.length} symbols, ` +
            `${totalPushed} snapshots pushed (${batches.length} batches). ` +
            `Missing: [${allMissing.slice(0, 10).join(',')}${allMissing.length > 10 ? '...' : ''}]`
        );
    }
}

// ============================================================
// 8. TOKEN HELPER
// ============================================================
async function fetchWsToken() {
    const workerBase = window.WORKER_BASE_URL ?? 'https://api-saham.mkemalw.workers.dev';

    // 1. Check localStorage override (manual dev config)
    const local = localStorage.getItem('ipot_ws_token') ?? localStorage.getItem('IPOT_APPSESSION');
    if (local) { console.log('[fetchWsToken] using localStorage token'); return local; }

    // 2. Try worker proxy
    try {
        const resp = await fetch(`${workerBase}/ws-token`, {
            signal: AbortSignal.timeout(5000)
        });
        if (resp.ok) {
            const data = await resp.json();
            const token = data?.token ?? data?.appsession ?? null;
            if (token) { console.log('[fetchWsToken] got token from worker proxy'); return token; }
        }
    } catch (e) {
        console.warn('[fetchWsToken] worker proxy failed:', e.message);
    }

    console.warn(
        '[fetchWsToken] no token found.\n' +
        'To set manually: localStorage.setItem("ipot_ws_token", "<YOUR_TOKEN>")\n' +
        'Token is the ?appsession= value from the IPOT web app URL.'
    );
    return null;
}

// ============================================================
// 9. PUBLIC API
// ============================================================
window.MostActivePipeline = {
    ScoreMath,
    RankTrailStore,
    Ob2RollingMetrics,
    HotScoreEngine,
    MostActiveClient,
    OrderbookClient,
    MostActiveOrchestrator,
    fetchWsToken,
};

console.log('[MostActivePipeline] loaded — PRD 0012 v1');
