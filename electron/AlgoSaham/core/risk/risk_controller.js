// risk_controller.js - The Execution & Safety Layer
const executionEngine = require('../engine/execution');

class RiskController {
    constructor() {
        this.execution = executionEngine;
        this.defaultLot = 1;
        this.positions = new Map(); // code -> { lot, avgPrice, lastPrice }

        this.execution.on('order-update', (update) => this._handleOrderUpdate(update));
    }

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
     * @returns {Array<{code: string, lot: number, avgPrice: number, lastPrice: number}>}
     */
    getOpenPositions() {
        return Array.from(this.positions.entries()).map(([code, info]) => ({
            code,
            lot: info.lot,
            avgPrice: info.avgPrice,
            lastPrice: info.lastPrice
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
        if (status !== 'M') {
            return; // only handle matched fills
        }

        const cmd = String(update.cmd || '').toUpperCase();
        const code = String(update.code).toUpperCase();
        const lot = Number(update.vol || update.volume || 0);
        const price = Number(update.price);

        if (!Number.isFinite(lot) || lot <= 0) return;

        const current = this.positions.get(code) || { lot: 0, avgPrice: 0, lastPrice: price };

        if (cmd === 'BUY') {
            const totalLot = current.lot + lot;
            const gross = current.lot * current.avgPrice + lot * price;
            current.lot = totalLot;
            current.avgPrice = totalLot > 0 ? gross / totalLot : 0;
            current.lastPrice = price;
        } else if (cmd === 'SELL') {
            const remainingLot = Math.max(0, current.lot - lot);
            current.lot = remainingLot;
            current.lastPrice = price;
            if (remainingLot === 0) {
                current.avgPrice = 0;
            }
        }

        if (current.lot > 0) {
            this.positions.set(code, current);
        } else {
            this.positions.delete(code);
        }
    }
}

module.exports = new RiskController();
