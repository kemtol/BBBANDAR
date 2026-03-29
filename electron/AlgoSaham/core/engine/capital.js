/**
 * capital.js — Capital Adequacy Check via CASHINFO
 *
 * Requests CASHINFO from IPOT WS and parses buying power,
 * account type (Margin/Regular), and cash balance.
 *
 * Usage:
 *   capitalChecker.request(ws, custcode)
 *   capitalChecker.on('update', ({ buyingPower, accountType, ... }) => {})
 */
const EventEmitter = require('events');

// CASHINFO rec field indices (verified from ws-dump analysis 2026-03-11)
const FIELD = {
  CUSTCODE: 5,
  STATUS_MSG: 10,
  CREDIT_LIMIT: 14,
  CASH_BALANCE: 16,
  MKT_VALUE: 19,
  NET_VALUE: 20,
  PENDING_BUY: 25,
  PENDING_SELL: 26,
  DATE_T0: 27,
  ACCOUNT_TYPE: 69   // 'M' = Margin, 'R' = Regular
};

function parseNum(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

class CapitalChecker extends EventEmitter {
  constructor() {
    super();
    this._lastSnapshot = null;
  }

  /**
   * Parse a CASHINFO response rec array into a structured object.
   * @param {Array<string>} rec - The rec array from CASHINFO response
   * @returns {Object|null}
   */
  parseCashInfo(rec) {
    if (!Array.isArray(rec) || rec.length < 70) {
      return null;
    }

    const snapshot = {
      custcode: rec[FIELD.CUSTCODE] || '',
      statusMsg: rec[FIELD.STATUS_MSG] || '',
      creditLimit: parseNum(rec[FIELD.CREDIT_LIMIT]),
      cashBalance: parseNum(rec[FIELD.CASH_BALANCE]),
      marketValue: parseNum(rec[FIELD.MKT_VALUE]),
      netValue: parseNum(rec[FIELD.NET_VALUE]),
      pendingBuy: parseNum(rec[FIELD.PENDING_BUY]),
      pendingSell: parseNum(rec[FIELD.PENDING_SELL]),
      dateT0: rec[FIELD.DATE_T0] || '',
      accountType: rec[FIELD.ACCOUNT_TYPE] || 'R',  // 'M' or 'R'
      isMargin: rec[FIELD.ACCOUNT_TYPE] === 'M',
      ts: Date.now()
    };

    // Buying power = credit limit - pending buy (simplified)
    // For margin: can use credit limit
    // For regular: cash balance - pending buy
    if (snapshot.isMargin) {
      snapshot.buyingPower = Math.max(0, snapshot.creditLimit - snapshot.pendingBuy);
    } else {
      snapshot.buyingPower = Math.max(0, snapshot.cashBalance - snapshot.pendingBuy);
    }

    this._lastSnapshot = snapshot;
    this.emit('update', snapshot);
    return snapshot;
  }

  /**
   * Build a CASHINFO WS request payload
   * @param {number} cid
   * @param {number} cmdid
   * @param {string} custcode
   * @returns {Object}
   */
  buildRequest(cid, cmdid, custcode) {
    return {
      event: 'cmd',
      data: {
        cmdid,
        param: {
          service: 'porto',
          cmd: 'CASHINFO',
          param: {
            custcode
          }
        }
      },
      cid
    };
  }

  /**
   * Check if a proposed order is within capital limits
   * @param {number} price
   * @param {number} lot
   * @param {Object} [options]
   * @param {number} [options.feeRate] - Broker fee as decimal (e.g. 0.0015 = 0.15%)
   * @returns {{ ok: boolean, reason?: string, required: number, available: number }}
   */
  canAfford(price, lot, options = {}) {
    if (!this._lastSnapshot) {
      return { ok: false, reason: 'No capital data yet', required: 0, available: 0 };
    }
    const feeRate = options.feeRate || 0.0015; // 0.15% default
    const shares = lot * 100;
    const gross = price * shares;
    const fee = Math.ceil(gross * feeRate);
    const required = gross + fee;
    const available = this._lastSnapshot.buyingPower;

    if (required > available) {
      return {
        ok: false,
        reason: `Insufficient funds: need ${required.toLocaleString()}, have ${available.toLocaleString()}`,
        required,
        available
      };
    }
    return { ok: true, required, available };
  }

  /** @returns {Object|null} */
  getSnapshot() {
    return this._lastSnapshot ? { ...this._lastSnapshot } : null;
  }

  /** @returns {boolean} True if at least one CASHINFO has been parsed */
  isReady() {
    return this._lastSnapshot !== null;
  }
}

module.exports = new CapitalChecker();
