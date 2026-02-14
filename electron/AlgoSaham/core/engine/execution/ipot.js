const WebSocket = require('ws');
const EventEmitter = require('events');

const WSS_ENDPOINT = 'wss://ipotapp.ipot.id/socketcluster/';
const DEFAULT_HEADERS = {
  Origin: 'https://indopremier.com',
  Referer: 'https://indopremier.com/#ipot/app/marketlive',
  Accept: '*/*'
};

function mask(value) {
  if (!value) return '(none)';
  const str = String(value);
  if (str.length <= 6) {
    return str.slice(0, 1) + '*'.repeat(Math.max(0, str.length - 2)) + str.slice(-1);
  }
  return `${str.slice(0, 4)}***${str.slice(-3)}`;
}

class ExecutionEngine extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this._connecting = false;
    this._connectPromise = null;
    this._closedByClient = false;

    this._headers = { ...DEFAULT_HEADERS };
    this._cookieHeader = null;
    this._appSession = null;
    this._agentToken = null;
    this._custcode = null;
    this._userAgent = null;
    this._logger = null;

    this._cidCounter = 100;
    this._submitEpoch = 0;
    this._submitSequence = 0;

    this._pendingOrders = new Map(); // cid -> orderCtx
    this._ordersByJats = new Map(); // jatsorderno -> orderCtx

    this._heartbeatTimer = null;
  }

  /**
   * Connect to IPOT execution WebSocket
   * @param {Object} options
   * @param {string} options.appSession - Token for SocketCluster query string
   * @param {string} options.agentToken - Auth token returned after login
   * @param {string} options.custcode - Primary customer code
   * @param {string} [options.cookies] - Cookie header string from browser session
   * @param {string} [options.userAgent] - Browser user agent to mimic
   * @param {Function} [options.logger] - Optional logger callback
   * @returns {Promise<void>}
   */
  connect(options = {}) {
    const {
      appSession,
      agentToken,
      custcode,
      cookies,
      userAgent,
      logger
    } = options;

    if (this.connected) {
      this._log('Already connected. Skipping connect request.');
      return Promise.resolve();
    }

    if (this._connecting) {
      this._log('Connection in progress. Reusing existing promise.');
      return this._connectPromise || Promise.resolve();
    }

    if (!appSession) {
      const err = new Error('Missing appSession token for execution engine connect');
      this._log(err.message);
      return Promise.reject(err);
    }

    if (!agentToken) {
      const err = new Error('Missing agent token for execution engine connect');
      this._log(err.message);
      return Promise.reject(err);
    }

    if (!custcode) {
      const err = new Error('Missing custcode for execution engine connect');
      this._log(err.message);
      return Promise.reject(err);
    }

    this._logger = typeof logger === 'function' ? logger : null;
    this._appSession = appSession;
    this._agentToken = agentToken;
    this._custcode = custcode;
    this._cookieHeader = cookies || null;
    this._userAgent = userAgent || null;

    if (this._userAgent) {
      this._headers['User-Agent'] = this._userAgent;
    } else {
      this._headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    if (this._cookieHeader) {
      this._headers.Cookie = this._cookieHeader;
    } else {
      delete this._headers.Cookie;
    }

    this._connecting = true;
    this._closedByClient = false;
    const wsUrl = `${WSS_ENDPOINT}?appsession=${encodeURIComponent(this._appSession)}`;

    this._log(`Connecting to execution socket (custcode=${mask(this._custcode)})...`);

    this._connectPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl, {
          headers: { ...this._headers },
          perMessageDeflate: false,
          handshakeTimeout: 15000
        });
      } catch (err) {
        this._connecting = false;
        this.ws = null;
        reject(err);
        return;
      }

      const cleanUpAndReject = (err) => {
        if (!this._connecting) {
          this.emit('error', err);
          return;
        }
        this._connecting = false;
        this.ws = null;
        reject(err);
      };

      this.ws.on('open', () => {
        this.connected = true;
        this._connecting = false;
        this._log('Execution socket connected. Sending handshake...');
        this._sendHandshake();
        this._startHeartbeat();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (raw) => {
        this._handleMessage(raw);
      });

      this.ws.on('close', (code) => {
        const reason = `Socket closed (code ${code})`;
        this._log(reason);
        this._stopHeartbeat();
        this._clearPending('Socket closed');
        const wasConnected = this.connected;
        this.connected = false;
        this._connecting = false;
        this.ws = null;
        if (!this._closedByClient && wasConnected) {
          this.emit('disconnected', { code });
        }
      });

      this.ws.on('error', (err) => {
        this._log(`Socket error: ${err.message}`);
        if (this._connecting) {
          cleanUpAndReject(err);
        } else {
          this.emit('error', err);
        }
      });

      this.ws.on('unexpected-response', (req, res) => {
        const err = new Error(`Unexpected response ${res.statusCode} ${res.statusMessage}`);
        this._log(err.message);
        if (this._connecting) {
          cleanUpAndReject(err);
        } else {
          this.emit('error', err);
        }
      });
    });

    return this._connectPromise;
  }

  disconnect() {
    if (!this.ws) {
      return;
    }
    this._closedByClient = true;
    this._log('Disconnecting execution socket...');
    this._stopHeartbeat();
    try {
      this.ws.close();
    } catch (_) {
      // ignore
    }
    this.ws = null;
    this.connected = false;
    this._connecting = false;
  }

  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  isConnecting() {
    return this._connecting;
  }

  placeBuy(params = {}) {
    const payload = { ...params, side: 'BUY' };
    return this._placeOrder(payload);
  }

  placeSell(params = {}) {
    const payload = { ...params, side: 'SELL' };
    return this._placeOrder(payload);
  }

  /**
   * Generic order placement
   * @param {Object} params
   * @param {'BUY'|'SELL'} params.side
   * @param {string} params.code
   * @param {number} params.price
   * @param {number} params.lot
   * @returns {number} cid used for the order
   */
  _placeOrder(params = {}) {
    const side = String(params.side || '').toUpperCase();
    const code = String(params.code || '').toUpperCase().trim();
    const price = Number(params.price);
    const lot = Number(params.lot);

    if (!this.isConnected()) {
      throw new Error('Execution socket is not connected');
    }
    if (!['BUY', 'SELL'].includes(side)) {
      throw new Error(`Invalid order side: ${params.side}`);
    }
    if (!code || code.length < 2) {
      throw new Error('Invalid stock code');
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('Invalid price');
    }
    if (!Number.isInteger(lot) || lot <= 0) {
      throw new Error('Invalid lot size');
    }

    const cid = this._nextCid();
    const submitid = this._nextSubmitId();

    const payload = {
      event: 'submit',
      data: {
        cmdid: cid,
        param: {
          service: 'stocktrade',
          cmd: side,
          param: {
            custcode: this._custcode,
            code,
            price,
            vol: lot
          },
          submitid
        }
      },
      cid
    };

    const orderCtx = {
      cid,
      submitid,
      side,
      code,
      price,
      lot,
      createdAt: Date.now()
    };

    this._pendingOrders.set(cid, orderCtx);

    this._sendJSON(payload);
    this.emit('order-submitted', { ...orderCtx });
    this._log(`Order submitted: ${side} ${code} @ ${price} x ${lot} (cid=${cid}, submitid=${submitid})`);

    return cid;
  }

  _sendHandshake() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = {
      event: '#handshake',
      data: {
        authToken: this._agentToken || null
      },
      cid: this._nextCid()
    };
    this._sendJSON(payload, false);
  }

  _sendJSON(payload, track = true) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Socket not ready for send');
    }
    try {
      const raw = JSON.stringify(payload);
      this.ws.send(raw);
    } catch (err) {
      this._log(`Failed to send payload: ${err.message}`);
      if (track && payload && payload.cid) {
        this._pendingOrders.delete(payload.cid);
      }
      throw err;
    }
  }

  _handleMessage(raw) {
    if (!raw) return;

    if (raw === '#1') {
      this._sendPong();
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (!msg) return;

    if (msg.event === '#handshake' || msg.event === '#setAuthToken') {
      if (msg.data && msg.data.authToken) {
        this._agentToken = msg.data.authToken;
        this.emit('auth-token-updated', { authToken: this._agentToken });
      }
      this._log(`Handshake ack: ${msg.event}`);
      return;
    }

    if (typeof msg.rid !== 'undefined') {
      this._handleAck(msg);
      return;
    }

    if (msg.event === 'push' && msg.data && msg.data.rtype === 'ORDER') {
      this._handleOrderUpdate(msg.data);
      return;
    }

    if (msg.event === '#publish' && msg.data && msg.data.rtype === 'ORDER') {
      this._handleOrderUpdate(msg.data);
      return;
    }
  }

  _handleAck(msg) {
    const cid = msg.rid;
    const orderCtx = this._pendingOrders.get(cid);
    if (!orderCtx) {
      return;
    }

    this._pendingOrders.delete(cid);

    const status = msg.data?.status || 'UNKNOWN';
    const message = msg.data?.message || '';
    const jatsorderno = msg.data?.data?.jatsorderno || null;

    if (jatsorderno) {
      orderCtx.jatsorderno = jatsorderno;
      this._ordersByJats.set(jatsorderno, orderCtx);
    }

    const payload = {
      cid,
      status,
      message,
      jatsorderno,
      order: { ...orderCtx },
      ts: Date.now(),
      raw: msg
    };

    if (status === 'OK') {
      this.emit('order-ack', payload);
      this._log(`ACK OK cid=${cid} ${orderCtx.side} ${orderCtx.code} jats=${jatsorderno || '-'} message=${message || 'OK'}`);
    } else {
      this.emit('order-error', payload);
      this._log(`ACK ERROR cid=${cid} status=${status} message=${message}`);
    }
  }

  _handleOrderUpdate(data) {
    if (!data) return;
    const code = String(data.code || '').toUpperCase();
    const cmd = String(data.cmd || '').toUpperCase();
    const status = String(data.status || '').toUpperCase();
    const price = Number(data.price);
    const vol = Number(data.vol || data.volume || 0);
    const jatsorderno = data.jatsorderno || data.orderid || null;

    const linkedOrder = jatsorderno ? this._ordersByJats.get(jatsorderno) : null;

    if (linkedOrder && status === 'M' && Number.isFinite(vol)) {
      linkedOrder.lastMatchedPrice = price;
      linkedOrder.lastMatchedLot = vol;
    }

    const update = {
      code,
      cmd,
      status,
      price,
      vol,
      jatsorderno,
      ts: Date.now(),
      raw: data,
      order: linkedOrder ? { ...linkedOrder } : null
    };

    this.emit('order-update', update);
    this._log(`ORDER UPDATE ${cmd} ${code} status=${status} price=${price} vol=${vol} jats=${jatsorderno || '-'}`);
  }

  _sendPong() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send('#2');
    } catch (_) {
      // ignore
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        if (typeof this.ws.ping === 'function') {
          this.ws.ping();
        }
      } catch (_) {
        // ignore ping errors
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _clearPending(reason) {
    if (this._pendingOrders.size === 0) return;
    for (const [cid, orderCtx] of this._pendingOrders.entries()) {
      this.emit('order-error', {
        cid,
        status: 'DISCONNECTED',
        message: reason,
        order: { ...orderCtx },
        ts: Date.now()
      });
    }
    this._pendingOrders.clear();
    this._ordersByJats.clear();
  }

  _nextCid() {
    this._cidCounter += 1;
    return this._cidCounter;
  }

  _nextSubmitId() {
    const now = Math.floor(Date.now() / 1000);
    if (now === this._submitEpoch) {
      this._submitSequence += 1;
    } else {
      this._submitEpoch = now;
      this._submitSequence = 0;
    }
    return Number(`${now}${this._submitSequence.toString().padStart(2, '0')}`);
  }

  _log(message) {
    const formatted = `[EXEC] ${message}`;
    if (this._logger) {
      try {
        this._logger(formatted);
        return;
      } catch (_) {
        // fall back to console
      }
    }
    // eslint-disable-next-line no-console
    console.log(formatted);
  }
}

module.exports = new ExecutionEngine();
