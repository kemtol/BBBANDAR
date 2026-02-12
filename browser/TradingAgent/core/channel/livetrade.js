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

        // Recent trades buffer
        this.recentTrades = [];
        this._numberFormatter = new Intl.NumberFormat('id-ID');

        // Logging
        this.log = console.log;
  // Init probe (Time & Sales readiness)
  this.INIT_PROBE_DURATION_MS = 5000;

        this.hasInitProbeRun = false;
        this.initProbeActive = false;
        this.initProbeTimer = null;
        this.initProbeTrades = 0;
        this._initProbeListener = null;
        this._initProbeStartedAt = null;

        // Debugging helpers
        this._zeroTradeLogCount = 0;
        this._ZERO_TRADE_LOG_LIMIT = 5;
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

        this.log = logFn || this.log || console.log;

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
            this.recentTrades = [];
            this.hasInitProbeRun = false;
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
            this._cancelInitProbe('socket closed');
            this._scheduleReconnect(token);
        });

        this.ws.on('error', (err) => {
            this.log(`[LIVETRADE] ❌ WebSocket error: ${err.message}`);
            if (this.initProbeActive) {
                this._cancelInitProbe('socket error');
            }
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
        if (!this.hasInitProbeRun) {
            this._runInitProbe(this.INIT_PROBE_DURATION_MS);
        }
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
                        const isMeaningful = this._isMeaningfulTrade(trade);

                        if (!isMeaningful) {
                            if (this._zeroTradeLogCount < this._ZERO_TRADE_LOG_LIMIT) {
                                this._zeroTradeLogCount += 1;
                                const rawPreview = typeof tradeData === 'string'
                                    ? tradeData
                                    : JSON.stringify(tradeData);
                                this.log(`[LIVETRADE][debug] Data LT diabaikan (#${this._zeroTradeLogCount}): ticker=${trade.ticker} price=${trade.price} vol=${trade.vol} raw=${rawPreview}`);
                            }
                            // Tetap emit raw envelope untuk logging eksternal
                            this.emit('trade-raw', {
                                v: 2,
                                fmt: trade._fmt,
                                src: 'ipot_ws',
                                raw: tradeData,
                                ts: trade.ts,
                                ts_quality: trade.ts_quality
                            });
                            return;
                        }

                        this.stats.totalTrades++;
                        this.stats.lastTradeAt = Date.now();

                        this._rememberTrade(trade);

                        // Emit for any listener (strategy engine, UI, dll.)
                        this.emit('trade', trade);

                        // Emit dengan raw envelope untuk arsip
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

            const firstField = parts[0];

            // Legacy format: YYYYMMDD|HHMMSS|TICKER|PRICE|VOL|...
            if (/^\d{8}$/.test(firstField)) {
                const dateStr = parts[0];
                const timeStr = parts[1] || '';
                const ticker = parts[2];
                const price = parseFloat(parts[3]) || 0;
                const vol = parseInt(parts[4], 10) || 0;
                const side = parts[5] || '';
                const extra = parts.slice(6);

                let ts = Date.now();
                let ts_quality = 'ingestion';

                if (timeStr.length === 6) {
                    try {
                        const y = dateStr.slice(0, 4);
                        const m = dateStr.slice(4, 6);
                        const d = dateStr.slice(6, 8);
                        const hh = timeStr.slice(0, 2);
                        const mm = timeStr.slice(2, 4);
                        const ss = timeStr.slice(4, 6);
                        const isoStr = `${y}-${m}-${d}T${hh}:${mm}:${ss}+07:00`;
                        const utcMs = Date.parse(isoStr);
                        if (!Number.isNaN(utcMs)) {
                            ts = utcMs;
                            ts_quality = 'derived';
                        }
                    } catch (e) { /* fallback to ingestion time */ }
                }

                return {
                    date: dateStr,
                    time: timeStr,
                    ticker,
                    price,
                    vol,
                    side,
                    extra,
                    ts,
                    ts_quality,
                    _fmt: 'pipe_v1'
                };
            }

            // Newer LT format observed from SocketCluster (side|time|...)
            if (/^[A-Za-z]$/.test(firstField) && parts.length >= 8) {
                const side = firstField.toUpperCase();
                const timeStr = parts[1] || '';
                const sequence = parts[2] || '';
                const ticker = parts[3] || 'UNKNOWN';
                const board = parts[4] || '';
                const tradeRef = parts[5] || '';
                const price = parseFloat(parts[6]) || 0;
                const vol = parseInt(parts[7], 10) || 0;
                const extra = parts.slice(8);

                const ts = this._deriveSameDayTimestamp(timeStr);
                const dateStr = this._formatDateLabel(ts);
                const ts_quality = timeStr.length === 6 ? 'derived_time_only' : 'ingestion';

                return {
                    date: dateStr,
                    time: timeStr,
                    ticker,
                    price,
                    vol,
                    side,
                    board,
                    tradeRef,
                    sequence,
                    extra,
                    ts,
                    ts_quality,
                    _fmt: 'pipe_v2'
                };
            }

            // Unknown string format: fallback to object-like
            return {
                ticker: parts[2] || parts[0] || 'UNKNOWN',
                price: parseFloat(parts[3]) || 0,
                vol: parseInt(parts[4], 10) || 0,
                side: parts[0] || '',
                ts: Date.now(),
                ts_quality: 'ingestion',
                _fmt: 'pipe_unknown',
                raw_parts: parts
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
        this._cancelInitProbe('manual disconnect');
        this.hasInitProbeRun = false;
        this.connected = false;
        this._zeroTradeLogCount = 0;
        if (this.log) this.log('[LIVETRADE] 🛑 Disconnected.');
    }

    _runInitProbe(durationMs = this.INIT_PROBE_DURATION_MS) {
        if (this.initProbeActive || this.hasInitProbeRun) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.initProbeActive = true;
        this.initProbeTrades = 0;
        this._initProbeStartedAt = Date.now();

        const seconds = durationMs % 1000 === 0
            ? (durationMs / 1000).toString()
            : (durationMs / 1000).toFixed(1);

        this.log(`[LIVETRADE] 🔍 Init probe: mendengarkan Time & Sales selama ${seconds}s...`);

        this._initProbeListener = () => {
            this.initProbeTrades += 1;
        };
        this.on('trade', this._initProbeListener);

        this.initProbeTimer = setTimeout(() => {
            this._finishInitProbe();
        }, durationMs);
    }

    _finishInitProbe() {
        if (!this.initProbeActive) return;

        if (this._initProbeListener) {
            this.off('trade', this._initProbeListener);
            this._initProbeListener = null;
        }
        if (this.initProbeTimer) {
            clearTimeout(this.initProbeTimer);
            this.initProbeTimer = null;
        }

        const startedAt = this._initProbeStartedAt || Date.now();
        const durationMs = Date.now() - startedAt;
        const secondsRaw = durationMs / 1000;
        let secondsLabel;
        if (secondsRaw < 1) {
            secondsLabel = secondsRaw.toFixed(2);
        } else {
            secondsLabel = Number.isInteger(secondsRaw) ? secondsRaw.toString() : secondsRaw.toFixed(1);
        }

        const tradeCount = this.initProbeTrades;

        this.initProbeActive = false;
        this.hasInitProbeRun = true;
        this.initProbeTrades = 0;
        this._initProbeStartedAt = null;

        this.log(`[LIVETRADE] 🎧 Init probe selesai. Tertangkap ${tradeCount} trade dalam ${secondsLabel}s.`);
        if (tradeCount === 0) {
            this.log('[LIVETRADE] ⚠️ Tidak ada Time & Sales selama init probe. Pastikan market sedang aktif atau cek koneksi.');
        } else {
            this.log('[LIVETRADE] ✅ Live trade stream siap untuk filtering Time & Sales.');
        }

        this._logRecentTrades(5);
        this._zeroTradeLogCount = 0;

        this.emit('init-probe-complete', {
            tradeCount,
            durationMs,
            startedAt,
            completedAt: Date.now()
        });
    }

    _logRecentTrades(limit = 5) {
        const sample = this.recentTrades.slice(-limit).reverse();
        if (sample.length === 0) {
            this.log('[LIVETRADE] check last 5: (belum ada Time & Sales yang terekam)');
            return;
        }

        const meaningful = sample.filter((trade) => this._isMeaningfulTrade(trade));
        if (meaningful.length === 0) {
            this.log('[LIVETRADE] check last 5: (belum ada Time & Sales bermakna, volume = 0)');
            return;
        }

        meaningful.forEach((trade, index) => {
            const numberLabel = `${index + 1})`;
            const ticker = trade.ticker || trade.symbol || 'UNKNOWN';
            const price = this._formatNumber(trade.price);
            const volume = this._formatNumber(trade.vol);
            const timeLabel = this._formatTimeLabel(trade);
            this.log(`[LIVETRADE] check last 5: ${numberLabel} ${ticker} ${price} x ${volume} @ ${timeLabel}`);
        });
    }

    _rememberTrade(trade) {
        if (!trade) return;
        if (!this.recentTrades) {
            this.recentTrades = [];
        }
        const snapshot = { ...trade };
        this.recentTrades.push(snapshot);
        if (this.recentTrades.length > 50) {
            this.recentTrades.shift();
        }
    }

    _isMeaningfulTrade(trade) {
        if (!trade) return false;
        const vol = typeof trade.vol === 'number' ? trade.vol : parseInt(trade.vol, 10);
        return Number.isFinite(vol) && vol > 0;
    }

    _formatNumber(value) {
        if (!this._numberFormatter) {
            this._numberFormatter = new Intl.NumberFormat('id-ID');
        }
        if (typeof value === 'number' && isFinite(value)) {
            return this._numberFormatter.format(value);
        }
        if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
            return this._numberFormatter.format(Number(value));
        }
        return '-';
    }

    _formatTimeLabel(trade) {
        if (trade && typeof trade.time === 'string' && trade.time.length === 6) {
            const hh = trade.time.slice(0, 2);
            const mm = trade.time.slice(2, 4);
            const ss = trade.time.slice(4, 6);
            return `${hh}:${mm}:${ss} WIB`;
        }
        if (trade && typeof trade.ts === 'number' && Number.isFinite(trade.ts)) {
            const date = new Date(trade.ts);
            if (!Number.isNaN(date.getTime())) {
                return date.toLocaleTimeString('id-ID', { hour12: false });
            }
        }
        return 'n/a';
    }

    _deriveSameDayTimestamp(timeStr) {
        if (typeof timeStr !== 'string' || timeStr.length !== 6 || /[^0-9]/.test(timeStr)) {
            return Date.now();
        }
        const now = new Date();
        const hh = parseInt(timeStr.slice(0, 2), 10);
        const mm = parseInt(timeStr.slice(2, 4), 10);
        const ss = parseInt(timeStr.slice(4, 6), 10);
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss);
        return candidate.getTime();
    }

    _formatDateLabel(ts) {
        if (typeof ts === 'number' && Number.isFinite(ts)) {
            const date = new Date(ts);
            if (!Number.isNaN(date.getTime())) {
                const y = date.getFullYear();
                const m = `${date.getMonth() + 1}`.padStart(2, '0');
                const d = `${date.getDate()}`.padStart(2, '0');
                return `${y}${m}${d}`;
            }
        }
        const fallback = new Date();
        const y = fallback.getFullYear();
        const m = `${fallback.getMonth() + 1}`.padStart(2, '0');
        const d = `${fallback.getDate()}`.padStart(2, '0');
        return `${y}${m}${d}`;
    }

    _cancelInitProbe(reason) {
        if (!this.initProbeActive) return;

        if (this._initProbeListener) {
            this.off('trade', this._initProbeListener);
            this._initProbeListener = null;
        }
        if (this.initProbeTimer) {
            clearTimeout(this.initProbeTimer);
            this.initProbeTimer = null;
        }

        this.initProbeActive = false;
        this.initProbeTrades = 0;
        this._initProbeStartedAt = null;
        this.hasInitProbeRun = false;

        if (this.log) {
            this.log(`[LIVETRADE] ℹ️ Init probe dibatalkan (${reason}). Akan dicoba ulang saat koneksi tersambung kembali.`);
        }
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
