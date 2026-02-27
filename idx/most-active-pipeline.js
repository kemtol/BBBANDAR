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

    _activityScore(code, rankNow, maxRank) {
        const rank_score = ScoreMath.norm((maxRank + 1 - rankNow), 1, maxRank);
        const vb = this._valueBuf.get(code) ?? [];
        const ob = this._volBuf.get(code) ?? [];
        const value_1m = vb[vb.length - 1] ?? 0;
        const vol_1m = ob[ob.length - 1] ?? 0;
        const value_5m_avg = vb.length > 1
            ? vb.slice(0, -1).reduce((s, v) => s + v, 0) / (vb.length - 1)
            : value_1m;
        const vol_5m_avg = ob.length > 1
            ? ob.slice(0, -1).reduce((s, v) => s + v, 0) / (ob.length - 1)
            : vol_1m;
        const value_accel = ScoreMath.norm(value_1m / Math.max(value_5m_avg, 1), 0.7, 2.5);
        const volume_accel = ScoreMath.norm(vol_1m / Math.max(vol_5m_avg, 1), 0.7, 2.5);
        return 0.45 * rank_score + 0.30 * value_accel + 0.25 * volume_accel;
    }

    _microScore(code) {
        const ob2 = this._ob2.get(code);
        if (!ob2 || ob2.updateCount < 2) return 50;
        const spread_health = 100 - ScoreMath.norm(ob2.spreadBpsAvg, 10, 80);
        return ScoreMath.clip(0.50 * ob2.bss + 0.40 * ob2.ats + 0.10 * spread_health, 0, 100);
    }

    _persistenceScore(code) {
        return ScoreMath.norm(this._trail.getConsecutive(code), 0, 10);
    }

    _trendQuality(code) {
        const slope = this._trail.getRankSlope10m(code);
        // Negative slope = rank improving → good
        const rank_slope_score = ScoreMath.norm(-slope, -1.0, 1.0);
        return 0.70 * rank_slope_score + 0.30 * 100; // volatility_penalty = 0 for now
    }

    _getSessionThreshold() {
        const now = new Date();
        const wibHour = parseInt(
            new Intl.DateTimeFormat('en', {
                timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false
            }).format(now),
            10
        );
        if (wibHour < 9 || wibHour >= 16) return 100; // outside market
        if (wibHour === 9) return 75;    // pre-open / open
        if (wibHour >= 15) return 73;   // late session
        return 70;                       // regular session
    }

    compute(code, rankNow, maxRank, riskMemory = null) {
        const activity = this._activityScore(code, rankNow, maxRank);
        const micro = this._microScore(code);
        const persistence = this._persistenceScore(code);
        const trend = this._trendQuality(code);

        const base = 0.35 * activity + 0.30 * micro + 0.20 * persistence + 0.15 * trend;

        let governance_penalty = 0;
        const risk_memory_missing = !riskMemory;
        if (riskMemory) {
            let p = 0;
            if (riskMemory.ever_fca) p += 12;
            const daysSinceFca = riskMemory.days_since_fca ?? 999;
            if (daysSinceFca <= 90) p += 10;
            p += Math.min(36, 18 * (Number(riskMemory.suspend_count_1y) || 0));
            if ((Number(riskMemory.uma_count_90d) || 0) >= 1) p += 8;
            governance_penalty = ScoreMath.clip(p, 0, 45);
        }

        const stage_score = ScoreMath.clip(base - governance_penalty, 0, 100);
        const ob2 = this._ob2.get(code);
        const bss = ob2?.bss ?? 50;
        const ats = ob2?.ats ?? 50;

        const threshold = this._getSessionThreshold();
        let stage_label;
        if (stage_score >= threshold && bss >= 65 && ats >= 65) {
            stage_label = 'On Stage';
        } else if (stage_score >= 50) {
            stage_label = 'Watch';
        } else {
            stage_label = 'Cooling';
        }

        const reason_codes = this._buildReasonCodes(code, {
            activity, micro, persistence, bss, ats, governance_penalty,
            risk_memory_missing, stage_score
        });

        return {
            stage_score: Math.round(stage_score),
            stage_label,
            reason_codes,
            risk_memory_missing,
            governance_penalty: Math.round(governance_penalty)
        };
    }

    _buildReasonCodes(code, { activity, micro, persistence, bss, ats, governance_penalty }) {
        const delta5  = this._trail.getRankDelta(code, 5);
        const delta15 = this._trail.getRankDelta(code, 15);
        const scored = [];

        if (delta15 < -3)  scored.push({ code: 'rank_improving_15m',      w: Math.abs(delta15) });
        if (delta5  < -2)  scored.push({ code: 'rank_improving_5m',       w: Math.abs(delta5) });
        if (delta5  >  2)  scored.push({ code: 'rank_deteriorating_5m',   w: delta5 });
        if (persistence >= 60) scored.push({ code: 'high_persistence_topN', w: persistence });
        if (bss >= 65)     scored.push({ code: 'bid_stack_persistent',    w: bss });
        else if (bss < 45) scored.push({ code: 'bid_pullback_fast',       w: 100 - bss });
        if (ats >= 65)     scored.push({ code: 'ask_thinning_consistent', w: ats });
        else if (ats < 45) scored.push({ code: 'ask_wall_reappearing',    w: 100 - ats });
        if (micro  >= 70)  scored.push({ code: 'tight_spread',            w: micro });
        else if (micro < 45) scored.push({ code: 'spread_widening',       w: 100 - micro });
        else               scored.push({ code: 'spread_normal',           w: 50 });
        if (bss >= 45 && bss < 65 && ats >= 45 && ats < 65)
                           scored.push({ code: 'mixed_microstructure',    w: 50 });
        if (delta5 === 0 && delta15 === 0)
                           scored.push({ code: 'rank_flat',               w: 30 });
        if (governance_penalty > 0)
                           scored.push({ code: 'fca_penalty_applied',     w: governance_penalty });

        const sorted = [...new Set(
            scored.sort((a, b) => b.w - a.w).map(c => c.code)
        )];
        const result = sorted.slice(0, 6);
        while (result.length < 3) result.push('spread_normal');
        return result;
    }

    getOb2Indicator(code) {
        const ob2 = this._ob2.get(code);
        if (!ob2 || ob2.updateCount < 2) {
            return { bss: 50, ats: 50, state: 'YELLOW_RED', missing: true };
        }
        return ob2.getIndicator();
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
        this._pendingRids = new Map(); // cid → 'roster' | ...
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
        const cid = this._nextCid();
        const now = new Date();
        const wibParts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric', month: 'numeric', day: 'numeric'
        }).formatToParts(now);
        const gp = (t) => wibParts.find(p => p.type === t)?.value || '';
        // IPOT expects YYYY-M-D (no leading zeros)
        const dateStr = `${gp('year')}-${Number(gp('month'))}-${Number(gp('day'))}`;

        this._pendingRids.set(cid, 'roster');
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
                        info: { orderby: [[3, 'ASC', 'N']], sum: [6] },
                        pagelen: 60,
                        slid: ''
                    }
                }
            },
            cid
        });
        console.log(`[MostActiveClient] queryRoster → cid=${cid}, date=${dateStr}`);
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
        this._pendingRids.set(cid, 'handshake');
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

        // Always forward to external handler (for OB2 etc.)
        this._onAnyMessage(msg);

        // Handshake ack
        const rid = msg?.rid;
        if (rid !== undefined && rid !== null) {
            const type = this._pendingRids.get(rid);
            this._pendingRids.delete(rid);

            if (type === 'handshake') {
                console.log('[MostActiveClient] handshake OK — querying roster');
                this.queryRoster();
                return;
            }

            if (type === 'roster') {
                const result = msg?.data?.data ?? msg?.data?.result ?? msg?.data;
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

    _parseRosterResult(result) {
        // IPOT result can be { rows: [...], total: N } or { data: { rows: [...] } }
        const rows = result?.rows ?? result?.data?.rows ?? [];
        if (!Array.isArray(rows) || !rows.length) {
            console.warn('[MostActiveClient] roster result empty or unrecognised format', result);
            return;
        }

        // Log raw first row for column-mapping validation
        console.debug('[MostActiveClient] roster raw row[0]:', rows[0]);

        const parsed = rows.map((row, idx) => {
            // Column layout for xen_qu_top_stock_gl (validated at runtime):
            // [0] code, [1] name, [2] last_price, [3] value, [4] volume, [5] change_pct, [6] freq
            // If row is an object (keyed), use keys; if array, use indices
            const isArr = Array.isArray(row);
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

        console.log(`[MostActiveClient] roster parsed: ${parsed.length} symbols`);
        this._onRoster(parsed);
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
        if (this._ws) {
            try { this._ws.close(); } catch {}
            this._ws = null;
        }
        this._connected = false;
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
     * Reconcile subscriptions with current top-N list.
     * Call once per minute cycle.
     */
    reconcile(topNCodes, sendFn) {
        const topSet = new Set(topNCodes);

        // Subscribe new entrants
        for (const code of topSet) {
            if (!this._subscriptions.has(code)) {
                this._subscribeSymbol(code, sendFn);
            } else {
                // Still in top-N → clear any grace period
                this._subscriptions.get(code).gracePeriodExpiry = null;
            }
        }

        // Mark exiting symbols with grace period
        for (const [code, entry] of this._subscriptions) {
            if (!topSet.has(code) && !entry.gracePeriodExpiry) {
                entry.gracePeriodExpiry = Date.now() + this._gracePeriodMs;
                console.log(`[OrderbookClient] ${code} grace period started`);
            }
        }

        // Unsubscribe expired
        for (const [code, entry] of this._subscriptions) {
            if (entry.gracePeriodExpiry && Date.now() >= entry.gracePeriodExpiry) {
                this._unsubscribeSymbol(code, sendFn);
            }
        }
    }

    _subscribeSymbol(code, sendFn) {
        const subsid = this._genSubsid();
        this._subscriptions.set(code, { subsid, gracePeriodExpiry: null });
        const cid = this._nextCid();
        sendFn({
            event: 'cmd',
            data: {
                cmdid: 248,
                param: { cmd: 'subscribe', service: 'mi', code, level: 10, subsid, rtype: 'OB2' }
            },
            cid
        });
        console.log(`[OrderbookClient] subscribed ${code} subsid=${subsid}`);
    }

    _unsubscribeSymbol(code, sendFn) {
        const entry = this._subscriptions.get(code);
        if (!entry) return;
        const cid = this._nextCid();
        sendFn({
            event: 'cmd',
            data: {
                cmdid: 248,
                param: { cmd: 'unsubscribe', service: 'mi', code, level: 10, subsid: entry.subsid, rtype: 'OB2' }
            },
            cid
        });
        this._subscriptions.delete(code);
        console.log(`[OrderbookClient] unsubscribed ${code}`);
    }

    /**
     * Handle an incoming WS message. If it's an OB2 update, feed it to scoreEngine.
     */
    handleMessage(msg, scoreEngine) {
        // Possible formats from IPOT SC:
        //   { event: 'data', data: { service:'mi', code:'BUVA', rtype:'OB2', data:{bid,ask} } }
        //   { event: 'cmd',  data: { result: { code, rtype, bid, ask } } }
        //   { data: { code, rtype:'OB2', bid, ask } }
        const d = msg?.data;
        if (!d) return;

        // Unwrap nested data
        const inner = d?.data ?? d?.result ?? d;
        const code = String(inner?.code ?? d?.code ?? '').toUpperCase();
        const rtype = String(inner?.rtype ?? d?.rtype ?? '').toUpperCase();

        if (rtype !== 'OB2') return;
        if (!code || !this._subscriptions.has(code)) return;

        const bid = inner?.bid ?? d?.bid ?? [];
        const ask = inner?.ask ?? d?.ask ?? [];
        if (!Array.isArray(bid) || !Array.isArray(ask) || !bid.length || !ask.length) return;

        scoreEngine.pushOb2(code, bid, ask);
        const indicator = scoreEngine.getOb2Indicator(code);
        this._onOb2Update(code, indicator);
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
    }

    stop() {
        clearInterval(this._minuteTimer);
        clearInterval(this._microTimer);
        clearInterval(this._staleTimer);
        this._obClient.unsubscribeAll((msg) => this._client.send(msg));
        this._client.destroy();
    }

    getCurrentRoster() { return [...this._currentRoster]; }

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

        // Top-N reconcile OB2
        this._topNCodes = rawRows.slice(0, this._topN).map(r => r.code);
        this._obClient.reconcile(this._topNCodes, (msg) => this._client.send(msg));

        // Build snapshot
        this._currentRoster = rawRows.map(r => this._buildSnapshot(r, maxRank));
        this._onUpdate({ type: 'minute', rows: this._currentRoster, ts: this._lastSuccessTs });

        console.log(`[Orchestrator] minute tick: ${rawRows.length} rows, topN: [${this._topNCodes.join(',')}]`);
    }

    _handleOb2Update(code, indicator) {
        const row = this._currentRoster.find(r => r.code === code);
        if (!row) return;
        row.ob2_indicator = indicator;
        // Recompute stage with fresh micro score
        const maxRank = this._currentRoster.length;
        const s = this._scoreEngine.compute(code, row.rank_now, maxRank);
        row.stage_score = s.stage_score;
        row.stage_label = s.stage_label;
        row.reason_codes = s.reason_codes;
    }

    _buildSnapshot(rosterRow, maxRank) {
        const code = rosterRow.code;
        const trail = this._trailStore.getTrail(code);
        const ob2   = this._scoreEngine.getOb2Indicator(code);
        const s     = this._scoreEngine.compute(code, rosterRow.rank, maxRank);
        return {
            code,
            rank_now:      rosterRow.rank,
            rank_delta_5m:  this._trailStore.getRankDelta(code, 5),
            rank_delta_15m: this._trailStore.getRankDelta(code, 15),
            rank_trail:    [...trail],
            ob2_indicator: ob2,
            stage_score:   s.stage_score,
            stage_label:   s.stage_label,
            reason_codes:  s.reason_codes,
            risk_memory_missing: true,   // FR-9 deferred
            // From roster
            last_price:  rosterRow.last_price,
            value:       rosterRow.value,
            volume:      rosterRow.volume,
            change_pct:  rosterRow.change_pct,
            // Placeholders (to be filled by future data providers)
            rvol5d:  null, rvol10d: null, rvol20d: null,
            fca5d:   null, fca10d:  null, fca20d:  null,
            suspend5d: null, suspend10d: null, suspend20d: null,
        };
    }

    _publishMicroUpdate() {
        if (!this._currentRoster.length) return;
        // Refresh OB2 indicators for top-N rows
        this._topNCodes.forEach(code => {
            const row = this._currentRoster.find(r => r.code === code);
            if (!row) return;
            row.ob2_indicator = this._scoreEngine.getOb2Indicator(code);
        });
        this._onUpdate({ type: 'micro', rows: this._currentRoster, ts: Date.now() });
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
