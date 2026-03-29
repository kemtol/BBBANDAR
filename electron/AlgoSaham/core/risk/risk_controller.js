// risk_controller.js - The Execution & Safety Layer
// Phantom Stop/TP — client-side TP/SL per emiten (PRD §6)
const EventEmitter = require('events');
const executionEngine = require('../engine/execution');

class RiskController extends EventEmitter {
    constructor() {
        super();
        this.execution = executionEngine;
        this.defaultLot = 1;
        this.positions = new Map(); // code -> { lot, avgPrice, lastPrice }

        /**
         * Per-emiten TP/SL config.
         * Map<string, { stopPct: number, tpPct: number, stopPrice: number|null, tpPrice: number|null, trailingStop: boolean }>
         * - stopPct/tpPct: percentage from avgPrice (e.g. 3 = 3%)
         * - stopPrice/tpPrice: absolute override (computed after fill if not set)
         * - trailingStop: when true, stopPrice ratchets up with price
         */
        this._tpsl = new Map();

        /** Default TP/SL percentages applied to new positions */
        this._defaultStopPct = 3;   // 3% cut loss
        this._defaultTpPct = 5;     // 5% take profit
        this._trailingEnabled = false;

        /** Tracks pending SL/TP sells to avoid duplicate triggers */
        this._pendingExit = new Set();

        this.execution.on('order-update', (update) => this._handleOrderUpdate(update));
    }

    // ── TP/SL Configuration ────────────────────────────────────

    /**
     * Set default stop/TP percentages for new positions.
     * @param {{ stopPct?: number, tpPct?: number, trailing?: boolean }} cfg
     */
    setDefaults(cfg = {}) {
        if (Number.isFinite(cfg.stopPct) && cfg.stopPct > 0) this._defaultStopPct = cfg.stopPct;
        if (Number.isFinite(cfg.tpPct) && cfg.tpPct > 0) this._defaultTpPct = cfg.tpPct;
        if (typeof cfg.trailing === 'boolean') this._trailingEnabled = cfg.trailing;
    }

    /**
     * Set TP/SL for a specific ticker (overrides defaults).
     * @param {string} code
     * @param {{ stopPct?: number, tpPct?: number, stopPrice?: number, tpPrice?: number, trailing?: boolean }} cfg
     */
    setTpsl(code, cfg = {}) {
        const key = (code || '').toUpperCase();
        if (!key) return;
        const existing = this._tpsl.get(key) || {
            stopPct: this._defaultStopPct,
            tpPct: this._defaultTpPct,
            stopPrice: null,
            tpPrice: null,
            trailingStop: this._trailingEnabled
        };
        if (Number.isFinite(cfg.stopPct) && cfg.stopPct > 0) existing.stopPct = cfg.stopPct;
        if (Number.isFinite(cfg.tpPct) && cfg.tpPct > 0) existing.tpPct = cfg.tpPct;
        if (Number.isFinite(cfg.stopPrice) && cfg.stopPrice > 0) existing.stopPrice = cfg.stopPrice;
        if (Number.isFinite(cfg.tpPrice) && cfg.tpPrice > 0) existing.tpPrice = cfg.tpPrice;
        if (typeof cfg.trailing === 'boolean') existing.trailingStop = cfg.trailing;
        this._tpsl.set(key, existing);
    }

    /**
     * Get TP/SL config for a ticker (or null if not configured).
     * @param {string} code
     * @returns {Object|null}
     */
    getTpsl(code) {
        const cfg = this._tpsl.get((code || '').toUpperCase());
        return cfg ? { ...cfg } : null;
    }

    // ── Price Feed ─────────────────────────────────────────────

    /**
     * Feed a market price tick. Called from portfolio/stream listener.
     * Evaluates TP/SL triggers for all matching positions.
     * @param {string} code
     * @param {number} price - last traded / bid price
     */
    onPriceTick(code, price) {
        const key = (code || '').toUpperCase();
        const pos = this.positions.get(key);
        if (!pos || pos.lot <= 0) return;
        if (!Number.isFinite(price) || price <= 0) return;

        pos.lastPrice = price;

        const tpsl = this._tpsl.get(key);
        if (!tpsl) return;

        // Trailing stop: ratchet up stopPrice when price rises
        if (tpsl.trailingStop && tpsl.stopPrice && price > pos.avgPrice) {
            const trailStop = price * (1 - tpsl.stopPct / 100);
            if (trailStop > tpsl.stopPrice) {
                tpsl.stopPrice = Math.round(trailStop);
            }
        }

        // Check stop loss
        if (tpsl.stopPrice && price <= tpsl.stopPrice) {
            this._triggerExit(key, pos, price, 'STOP_LOSS');
            return;
        }

        // Check take profit
        if (tpsl.tpPrice && price >= tpsl.tpPrice) {
            this._triggerExit(key, pos, price, 'TAKE_PROFIT');
        }
    }

    /**
     * Trigger a phantom stop/TP exit sell.
     * @private
     */
    _triggerExit(code, pos, triggerPrice, reason) {
        if (this._pendingExit.has(code)) return;  // already in-flight
        if (!this.execution.isConnected()) {
            console.warn(`[RISK] ${reason} triggered for ${code} @${triggerPrice} but execution not connected.`);
            this.emit('risk-alert', { code, reason, triggerPrice, error: 'not_connected' });
            return;
        }

        this._pendingExit.add(code);
        const lot = pos.lot;

        try {
            const cid = this.execution.placeSell({ code, price: triggerPrice, lot });
            console.log(`[RISK] ${reason} ${code} @${triggerPrice} x${lot} (cid=${cid})`);
            this.emit('phantom-trigger', { code, reason, triggerPrice, lot, cid });
        } catch (err) {
            console.error(`[RISK] ${reason} sell failed for ${code}: ${err.message}`);
            this._pendingExit.delete(code);
            this.emit('risk-alert', { code, reason, triggerPrice, error: err.message });
        }
    }

    // ── Order Submission ───────────────────────────────────────

    /**
     * Submit BUY order request via execution engine
     * @param {string|Object} symbolOrParams
     * @param {Object} [maybeParams]
     */
    executeEntry(symbolOrParams, maybeParams = {}) {
        const params = this._normalizeParams(symbolOrParams, maybeParams);
        const code = params.code;
        const price = Number(params.price);
        const lot = Number.isInteger(params.lot) && params.lot > 0 ? params.lot : this.defaultLot;

        if (!code) {
            console.warn('[RISK] executeEntry: kode saham tidak valid.');
            return;
        }
        if (!Number.isFinite(price) || price <= 0) {
            console.warn(`[RISK] ${code} gagal dieksekusi: harga tidak valid.`);
            return;
        }
        if (!this.execution.isConnected()) {
            console.warn('[RISK] Engine eksekusi belum siap. Order BUY dibatalkan.');
            return;
        }

        try {
            const cid = this.execution.placeBuy({ code, price, lot });
            console.log(`[RISK] BUY submit ${code} @${price} x${lot} (cid=${cid})`);
        } catch (err) {
            console.error(`[RISK] Gagal submit BUY ${code}: ${err.message}`);
        }
    }

    /**
     * Attempt to flatten all tracked positions using last known price (or override)
     * @param {Object} [options]
     * @param {number} [options.price] - fallback price for all tickers
     * @param {Object} [options.priceByCode] - per ticker price override (e.g., { BBCA: 9250 })
     */
    flattenAll(options = {}) {
        if (!this.execution.isConnected()) {
            console.warn('[RISK] Engine eksekusi belum terhubung. Tidak dapat flatten.');
            return;
        }

        const priceMap = options.priceByCode || {};
        const fallbackPrice = Number(options.price);
        const orders = [];

        for (const [code, position] of this.positions.entries()) {
            if (!position || position.lot <= 0) continue;
            const mapPrice = priceMap[code];
            const candidatePrice = Number.isFinite(mapPrice) ? Number(mapPrice) : fallbackPrice;
            const price = Number.isFinite(candidatePrice) && candidatePrice > 0
                ? candidatePrice
                : Number.isFinite(position.lastPrice) && position.lastPrice > 0
                    ? position.lastPrice
                    : NaN;

            if (!Number.isFinite(price) || price <= 0) {
                console.warn(`[RISK] Skip flatten ${code}: harga tidak tersedia.`);
                continue;
            }

            orders.push({ code, price, lot: position.lot });
        }

        if (orders.length === 0) {
            console.log('[RISK] Tidak ada posisi aktif untuk di-flatten.');
            return;
        }

        for (const order of orders) {
            try {
                const cid = this.execution.placeSell(order);
                console.log(`[RISK] FLATTEN submit ${order.code} @${order.price} x${order.lot} (cid=${cid})`);
            } catch (err) {
                console.error(`[RISK] Gagal flatten ${order.code}: ${err.message}`);
            }
        }
    }

    /**
     * Get shallow copy of open positions for diagnostics/UI
     * @returns {Array<{code: string, lot: number, avgPrice: number, lastPrice: number, tpsl: Object|null}>}
     */
    getOpenPositions() {
        return Array.from(this.positions.entries()).map(([code, info]) => ({
            code,
            lot: info.lot,
            avgPrice: info.avgPrice,
            lastPrice: info.lastPrice,
            tpsl: this._tpsl.has(code) ? { ...this._tpsl.get(code) } : null
        }));
    }

    _normalizeParams(symbolOrParams, maybeParams) {
        if (symbolOrParams && typeof symbolOrParams === 'object') {
            const source = symbolOrParams;
            return {
                code: typeof source.code === 'string' ? source.code.toUpperCase().trim() : (source.symbol || '').toUpperCase().trim(),
                price: source.price,
                lot: source.lot
            };
        }
        const symbol = typeof symbolOrParams === 'string' ? symbolOrParams.toUpperCase().trim() : '';
        return {
            code: symbol,
            price: maybeParams.price,
            lot: maybeParams.lot
        };
    }

    _handleOrderUpdate(update) {
        if (!update || !update.code || !update.status) return;
        const status = String(update.status).toUpperCase();
        const cmd = String(update.cmd || '').toUpperCase();
        const code = String(update.code).toUpperCase();
        const lot = Number(update.vol || update.volume || 0);
        const price = Number(update.price);

        // Clear pending exit flag on any terminal status for SELL
        if (cmd === 'SELL' && (status === 'M' || status === 'R' || status === 'C')) {
            this._pendingExit.delete(code);
        }

        if (status !== 'M') {
            return; // only handle matched fills for position tracking
        }

        if (!Number.isFinite(lot) || lot <= 0) return;

        const current = this.positions.get(code) || { lot: 0, avgPrice: 0, lastPrice: price };

        if (cmd === 'BUY') {
            const totalLot = current.lot + lot;
            const gross = current.lot * current.avgPrice + lot * price;
            current.lot = totalLot;
            current.avgPrice = totalLot > 0 ? gross / totalLot : 0;
            current.lastPrice = price;

            // Auto-compute TP/SL levels for new/updated position
            this._computeTpslLevels(code, current.avgPrice);
        } else if (cmd === 'SELL') {
            const remainingLot = Math.max(0, current.lot - lot);
            current.lot = remainingLot;
            current.lastPrice = price;
            if (remainingLot === 0) {
                current.avgPrice = 0;
                // Clean up TP/SL config when position fully closed
                this._tpsl.delete(code);
                this._pendingExit.delete(code);
            }
        }

        if (current.lot > 0) {
            this.positions.set(code, current);
        } else {
            this.positions.delete(code);
        }

        this.emit('position-change', { code, cmd, lot, price, remaining: current.lot });
    }

    /**
     * Compute absolute stopPrice & tpPrice from avgPrice and configured percentages.
     * @private
     */
    _computeTpslLevels(code, avgPrice) {
        if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;

        let cfg = this._tpsl.get(code);
        if (!cfg) {
            // Create default config for new position
            cfg = {
                stopPct: this._defaultStopPct,
                tpPct: this._defaultTpPct,
                stopPrice: null,
                tpPrice: null,
                trailingStop: this._trailingEnabled
            };
            this._tpsl.set(code, cfg);
        }

        cfg.stopPrice = Math.round(avgPrice * (1 - cfg.stopPct / 100));
        cfg.tpPrice = Math.round(avgPrice * (1 + cfg.tpPct / 100));

        console.log(`[RISK] ${code} TP/SL computed: SL@${cfg.stopPrice} (${cfg.stopPct}%) TP@${cfg.tpPrice} (${cfg.tpPct}%) from avg@${avgPrice}`);
    }
}

module.exports = new RiskController();
