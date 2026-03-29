/**
 * portfolio.js — Live Portfolio State from Broker
 *
 * Tracks STOCKPOS push data from IPOT WS to maintain a real-time
 * view of what the broker knows (not just local order tracking).
 *
 * Feeds into risk_controller for TP/SL decisions.
 *
 * STOCKPOS rec field mapping (verified from ws-dump 2026-03-11):
 *   [4]  custcode
 *   [5]  code (ticker)
 *   [6]  total_lot
 *   [7]  sell_pending
 *   [9]  available_lot
 *   [13] buy_today (lot)
 *   [14] sell_today (lot)
 *   [24] last_price
 *   [25] avg_price
 *   [29] board (RG=Regular)
 *   [33] mkt_value
 *   [34] pl (profit/loss)
 *   [35] pl_pct (percentage)
 */
const EventEmitter = require('events');

const FIELD = {
  CUSTCODE: 4,
  CODE: 5,
  TOTAL_LOT: 6,
  SELL_PENDING: 7,
  AVAILABLE: 9,
  BUY_TODAY: 13,
  SELL_TODAY: 14,
  LAST_PRICE: 24,
  AVG_PRICE: 25,
  BOARD: 29,
  MKT_VALUE: 33,
  PL: 34,
  PL_PCT: 35
};

function parseNum(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

class PortfolioManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Object>} ticker -> position object */
    this._positions = new Map();
    this._custcode = null;
  }

  /**
   * Parse a STOCKPOS rec array (from push event) and update internal state.
   * @param {string} code - Stock ticker
   * @param {Array<string>} rec - The rec array from STOCKPOS push
   * @returns {Object|null} The updated position
   */
  updateFromStockPos(code, rec) {
    if (!Array.isArray(rec) || rec.length < 36) {
      return null;
    }

    const ticker = (code || rec[FIELD.CODE] || '').toUpperCase();
    if (!ticker) return null;

    this._custcode = rec[FIELD.CUSTCODE] || this._custcode;

    const position = {
      code: ticker,
      custcode: rec[FIELD.CUSTCODE] || '',
      totalLot: parseNum(rec[FIELD.TOTAL_LOT]),
      sellPending: parseNum(rec[FIELD.SELL_PENDING]),
      availableLot: parseNum(rec[FIELD.AVAILABLE]),
      buyToday: parseNum(rec[FIELD.BUY_TODAY]),
      sellToday: parseNum(rec[FIELD.SELL_TODAY]),
      lastPrice: parseNum(rec[FIELD.LAST_PRICE]),
      avgPrice: parseNum(rec[FIELD.AVG_PRICE]),
      board: rec[FIELD.BOARD] || 'RG',
      marketValue: parseNum(rec[FIELD.MKT_VALUE]),
      pl: parseNum(rec[FIELD.PL]),
      plPct: parseNum(rec[FIELD.PL_PCT]),
      ts: Date.now()
    };

    if (position.totalLot > 0) {
      this._positions.set(ticker, position);
    } else {
      this._positions.delete(ticker);
    }

    this.emit('position-update', position);
    return position;
  }

  /**
   * Get a specific position
   * @param {string} code
   * @returns {Object|null}
   */
  getPosition(code) {
    const pos = this._positions.get((code || '').toUpperCase());
    return pos ? { ...pos } : null;
  }

  /**
   * Get all positions as array
   * @returns {Array<Object>}
   */
  getAllPositions() {
    return Array.from(this._positions.values()).map(p => ({ ...p }));
  }

  /**
   * Get list of tickers with open positions
   * @returns {string[]}
   */
  getHoldings() {
    return Array.from(this._positions.keys());
  }

  /**
   * Clear everything (e.g. on logout)
   */
  reset() {
    this._positions.clear();
    this._custcode = null;
    this.emit('reset');
  }

  /**
   * Build a STOCKPOS subscribe request
   * @param {number} cid
   * @param {number} cmdid
   * @param {string} custcode
   * @returns {Object}
   */
  buildSubscribeRequest(cid, cmdid, custcode) {
    return {
      event: 'cmd',
      data: {
        cmdid,
        param: {
          service: 'porto',
          cmd: 'STOCKPOS',
          subsid: `STOCKPOS_${custcode}`,
          param: {
            custcode,
            code: '*',
            subscribe: true
          },
          rtype: 'STOCKPOS'
        }
      },
      cid
    };
  }
}

module.exports = new PortfolioManager();
