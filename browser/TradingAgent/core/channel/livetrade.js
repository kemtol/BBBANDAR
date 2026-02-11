/**
 * livetrade.js — Live Trade Stream Tapping via IPOT SocketCluster
 * 
 * Ported from: workers/livetrade-taping (Cloudflare Durable Object)
 * Adapted for: Electron (Node.js runtime)
 * 
 * Uses the PUBLIC token (no login required) to subscribe to
 * real-time trade data from IPOT's WebSocket.
 * 
 * Protocol:
 *   1. Connect to wss://ipotapp.ipot.id/socketcluster/?appsession=<token>
 *   2. Send #handshake
 *   3. Subscribe to LT (Live Trade) with rtype="LT", code="*"
 *   4. Parse incoming pipe-delimited trade strings
 * 
 * Trade pipe format: YYYYMMDD|HHMMSS|TICKER|PRICE|VOL|...
 */
const WebSocket = require('ws');
const EventEmitter = require('events');

class LiveTradeStream extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.pingTimer = null;

        // Config
        this.RECONNECT_DELAY_MS = 5000;
        this.cidCounter = 1;

        // Stats
        this.stats = {
            totalTrades: 0,
            startedAt: null,
            lastTradeAt: null,
            reconnects: 0
        };
    }

    /**
     * Connect to WebSocket and start streaming live trades
     * @param {string} token - Public appsession token
     * @param {Function} logFn - Logger function (sends to dashboard terminal)
     */
    connect(token, logFn) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            logFn('[LIVETRADE] Already connected.');
            return;
        }

        this.log = logFn || console.log;

        const wsUrl = `wss://ipotapp.ipot.id/socketcluster/?appsession=${token}`;
        this.log('[LIVETRADE] 📡 Connecting to Live Trade stream...');

        try {
            const headers = {
                'Origin': 'https://indopremier.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://indopremier.com/#ipot/app/marketlive',
                'Accept': '*/*'
            };
            this.ws = new WebSocket(wsUrl, { headers, perMessageDeflate: false, handshakeTimeout: 15000 });
        } catch (err) {
            this.log(`[LIVETRADE] ❌ Connection failed: ${err.message}`);
            this._scheduleReconnect(token);
            return;
        }

        this.ws.on('open', () => {
            this.connected = true;
            this.stats.startedAt = Date.now();
            this.log('[LIVETRADE] ✅ WebSocket connected! Handshaking...');

            // SocketCluster handshake
            this.ws.send(JSON.stringify({
                event: '#handshake',
                data: { authToken: null },
                cid: this.cidCounter++
            }));

            // Subscribe after short delay for handshake
            setTimeout(() => {
                this._subscribeLiveTrade();
            }, 1000);
        });

        this.ws.on('message', (raw) => {
            this._handleMessage(raw);
        });

        this.ws.on('close', (code) => {
            this.connected = false;
            this.log(`[LIVETRADE] WebSocket closed (code: ${code}).`);
            this._scheduleReconnect(token);
        });

        this.ws.on('error', (err) => {
            this.log(`[LIVETRADE] ❌ WebSocket error: ${err.message}`);
            if (!this.connected) {
                this._scheduleReconnect(token);
            }
        });

        // Log non-101 responses (handshake rejected, etc.)
        this.ws.on('unexpected-response', (req, res) => {
            this.log(`[LIVETRADE] ❌ Unexpected response: ${res.statusCode} ${res.statusMessage}`);
        });
    }

    /**
     * Subscribe to Live Trade (LT) - global stream (code="*")
     */
    _subscribeLiveTrade() {
        const subLT = {
            event: 'cmd',
            data: {
                cmdid: 999,
                param: {
                    cmd: 'subscribe',
                    service: 'mi',
                    rtype: 'LT',
                    code: '*',
                    subsid: 'electron_livetrade'
                }
            },
            cid: this.cidCounter++
        };
        this.ws.send(JSON.stringify(subLT));
        this.log('[LIVETRADE] 📊 Subscribed to Live Trade (LT) global stream.');
    }

    /**
     * Handle incoming WebSocket messages
     * @param {Buffer|string} raw
     */
    _handleMessage(raw) {
        const msg = raw.toString();

        // SocketCluster ping/pong
        if (msg === '#1') {
            this.ws.send('#2');
            return;
        }

        if (msg === '' || msg.length === 0) return;

        try {
            const parsed = JSON.parse(msg);

            // Log handshake acknowledgements for visibility
            if (parsed.event === '#handshake' || parsed.event === '#setAuthToken') {
                this.log(`[LIVETRADE] 🔐 Handshake ack: ${parsed.event}`);
                return;
            }

            // Handle trade stream events
            if (parsed.event === 'stream' || parsed.event === '#publish') {
                const rtype = parsed.data?.rtype || parsed.rtype;

                if (rtype === 'LT') {
                    const tradeData = parsed.data?.data || parsed.data;
                    const trade = this._parseTrade(tradeData);

                    if (trade) {
                        this.stats.totalTrades++;
                        this.stats.lastTradeAt = Date.now();

                        // Emit for any listener (strategy engine, UI, etc.)
                        this.emit('trade', trade);

                        // Emit with raw envelope for archival
                        this.emit('trade-raw', {
                            v: 2,
                            fmt: trade._fmt,
                            src: 'ipot_ws',
                            raw: tradeData,
                            ts: trade.ts,
                            ts_quality: trade.ts_quality
                        });
                    }
                }
            }
        } catch (e) {
            // Ignore parse errors for non-JSON frames
        }
    }

    /**
     * Parse a trade from pipe-delimited string or object
     * Pipe format: YYYYMMDD|HHMMSS|TICKER|PRICE|VOL|...
     * 
     * @param {string|Object} data - Raw trade data
     * @returns {Object|null} Parsed trade object
     */
    _parseTrade(data) {
        if (!data) return null;

        // Pipe-delimited format (most common from IPOT)
        if (typeof data === 'string' && data.includes('|')) {
            const parts = data.split('|');
            if (parts.length < 5) return null;

            // Derive timestamp from trade data (WIB timezone)
            let ts = Date.now();
            let ts_quality = 'ingestion';

            const dateStr = parts[0]; // e.g., "20260210"
            const timeStr = parts[1]; // e.g., "143025"

            if (dateStr.length === 8 && timeStr.length === 6) {
                try {
                    const y = dateStr.slice(0, 4);
                    const m = dateStr.slice(4, 6);
                    const d = dateStr.slice(6, 8);
                    const hh = timeStr.slice(0, 2);
                    const mm = timeStr.slice(2, 4);
                    const ss = timeStr.slice(4, 6);
                    const isoStr = `${y}-${m}-${d}T${hh}:${mm}:${ss}+07:00`;
                    const utcMs = Date.parse(isoStr);
                    if (!isNaN(utcMs)) {
                        ts = utcMs;
                        ts_quality = 'derived';
                    }
                } catch (e) { /* fallback to ingestion time */ }
            }

            return {
                date: dateStr,
                time: timeStr,
                ticker: parts[2],
                price: parseFloat(parts[3]) || 0,
                vol: parseInt(parts[4]) || 0,
                side: parts[5] || '',           // Buy/Sell indicator if available
                extra: parts.slice(6),          // Any additional fields
                ts,
                ts_quality,
                _fmt: 'pipe'
            };
        }

        // Object format (fallback)
        if (typeof data === 'object') {
            return {
                ticker: data.code || data.ticker || data.symbol || 'UNKNOWN',
                price: parseFloat(data.price || data.last || 0),
                vol: parseInt(data.vol || data.volume || 0),
                side: data.side || '',
                ts: Date.now(),
                ts_quality: 'ingestion',
                _fmt: 'obj',
                _raw: data
            };
        }

        return null;
    }

    /**
     * Schedule a reconnection attempt
     * @param {string} token
     */
    _scheduleReconnect(token) {
        if (this.reconnectTimer) return;

        this.stats.reconnects++;
        this.log(`[LIVETRADE] 🔄 Reconnecting in ${this.RECONNECT_DELAY_MS / 1000}s... (attempt #${this.stats.reconnects})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(token, this.log);
        }, this.RECONNECT_DELAY_MS);
    }

    /**
     * Disconnect gracefully
     */
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        if (this.log) this.log('[LIVETRADE] 🛑 Disconnected.');
    }

    /**
     * Get current stream statistics
     */
    getStats() {
        return {
            connected: this.connected,
            ...this.stats,
            uptime: this.stats.startedAt
                ? Math.floor((Date.now() - this.stats.startedAt) / 1000) + 's'
                : null
        };
    }
}

// Singleton
module.exports = new LiveTradeStream();
