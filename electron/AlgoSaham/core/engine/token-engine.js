/**
 * token-engine.js — Centralized Token State Manager
 * 
 * 3-Tier Token Architecture:
 * 1. Public Token  — Auto (fetch from appsession.js like workers), for backtest/dry run/chart
 * 2. IPOT Agent    — After IPOT login, for real trade execution
 * 3. Stockbit Agent — After Stockbit login, for real trade execution
 */
const EventEmitter = require('events');
const https = require('https');

class TokenEngine extends EventEmitter {
    constructor() {
        super();
        this.state = {
            public: null,        // Public token (no login needed)
            ipotAgent: null,     // IPOT authenticated token
            stockbitAgent: null  // Stockbit authenticated token
        };
        this.accounts = {}; // broker -> { custcodes: [], main: string|null, updatedAt }
    }

    /**
     * Fetch PUBLIC token directly from IPOT appsession.js (like workers do)
     * No browser/cookies needed! Uses Node.js https module.
     * 
     * @returns {Promise<string|null>}
     */
    fetchPublicToken() {
        return new Promise((resolve) => {
            const url = 'https://indopremier.com/ipc/appsession.js';
            
            const options = {
                headers: {
                    'Accept': '*/*',
                    'User-Agent': 'TradingAgent/1.0',
                    'Origin': 'https://indopremier.com',
                    'Referer': 'https://indopremier.com/',
                }
            };

            const req = https.get(url, options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        console.error(`[TOKEN-ENGINE] appsession fetch failed: ${res.statusCode}`);
                        resolve(null);
                        return;
                    }

                    // Parse appsession from response (same patterns as workers)
                    const patterns = [
                        /appsession\s*[:=]\s*["']([^"']+)["']/i,
                        /appsession=([a-zA-Z0-9\-_]+)/i,
                        /["']appsession["']\s*[:,]\s*["']([^"']+)["']/i,
                    ];

                    let token = null;
                    for (const re of patterns) {
                        const m = data.match(re);
                        if (m && m[1]) { 
                            token = m[1]; 
                            break; 
                        }
                    }

                    // Fallback: look for token near "appsession"
                    if (!token) {
                        const near = data.match(/appsession[^A-Za-z0-9\-_]{0,30}([A-Za-z0-9\-_]{16,128})/i);
                        if (near) token = near[1];
                    }

                    if (token) {
                        this.state.public = token;
                        this.emit('public-token-ready', token);
                        console.log('[TOKEN-ENGINE] ✅ Public token fetched successfully');
                        resolve(token);
                    } else {
                        console.error('[TOKEN-ENGINE] Could not parse appsession from response');
                        console.error('[TOKEN-ENGINE] Response preview:', data.substring(0, 200));
                        resolve(null);
                    }
                });
            });

            req.on('error', (err) => {
                console.error('[TOKEN-ENGINE] Error fetching public token:', err.message);
                resolve(null);
            });

            req.setTimeout(10000, () => {
                req.destroy();
                console.error('[TOKEN-ENGINE] Request timeout');
                resolve(null);
            });
        });
    }

    /**
     * Extract PUBLIC token from IPOT page (fallback method)
     * @param {Electron.WebContents} webContents - Left pane webContents
     * @returns {Promise<string|null>}
     */
    async extractPublicToken(webContents) {
        // Method 0: Try direct fetch first (like workers)
        const directToken = await this.fetchPublicToken();
        if (directToken) return directToken;

        // Fallback: Try cookies/localStorage from webContents
        try {
            // Method 1: Try cookies on ipotapp.ipot.id
            const cookies = await webContents.session.cookies.get({ domain: 'ipotapp.ipot.id' });
            for (const c of cookies) {
                if (c.name === 'appsession' || c.name === 'session') {
                    this.state.public = c.value;
                    this.emit('public-token-ready', c.value);
                    return c.value;
                }
            }

            // Method 2: Try localStorage/sessionStorage injection
            const token = await webContents.executeJavaScript(`
                (function() {
                    var keys = ['appsession', 'token', 'sessionId', 'appSession'];
                    for (var i = 0; i < keys.length; i++) {
                        var v = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]);
                        if (v) return v;
                    }
                    return null;
                })();
            `);

            if (token) {
                this.state.public = token;
                this.emit('public-token-ready', token);
                return token;
            }

            // Method 3: Broader cookie search on .indopremier.com
            const allCookies = await webContents.session.cookies.get({ domain: '.indopremier.com' });
            for (const c of allCookies) {
                if (c.name.toLowerCase().includes('session') || c.name.toLowerCase().includes('token')) {
                    this.state.public = c.value;
                    this.emit('public-token-ready', c.value);
                    return c.value;
                }
            }

            return null;
        } catch (err) {
            console.error('[TOKEN-ENGINE] Error extracting public token:', err.message);
            return null;
        }
    }

    /**
     * Extract AGENT token after broker login.
     * This token allows trade execution.
     * 
     * @param {Electron.WebContents} webContents - Left pane webContents
     * @param {'ipot'|'stockbit'} broker
     * @returns {Promise<string|null>}
     */
    async extractAgentToken(webContents, broker) {
        try {
            let token = null;

            if (broker === 'ipot') {
                // After IPOT login, look for authenticated session
                const cookies = await webContents.session.cookies.get({ domain: '.indopremier.com' });
                for (const c of cookies) {
                    if (c.name === 'appsession' || c.name.toLowerCase().includes('auth')) {
                        token = c.value;
                        break;
                    }
                }

                // Fallback: try JS extraction for auth token
                if (!token) {
                    token = await webContents.executeJavaScript(`
                        (function() {
                            var keys = ['authToken', 'auth_token', 'accessToken', 'appsession'];
                            for (var i = 0; i < keys.length; i++) {
                                var v = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]);
                                if (v) return v;
                            }
                            return null;
                        })();
                    `);
                }

                if (token) {
                    this.state.ipotAgent = token;
                    this.emit('agent-token-ready', { broker: 'ipot', token });
                }

            } else if (broker === 'stockbit') {
                // Stockbit auth token extraction
                const cookies = await webContents.session.cookies.get({ domain: '.stockbit.com' });
                for (const c of cookies) {
                    if (c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session')) {
                        token = c.value;
                        break;
                    }
                }

                if (!token) {
                    token = await webContents.executeJavaScript(`
                        (function() {
                            var keys = ['token', 'access_token', 'authToken'];
                            for (var i = 0; i < keys.length; i++) {
                                var v = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]);
                                if (v) return v;
                            }
                            return null;
                        })();
                    `);
                }

                if (token) {
                    this.state.stockbitAgent = token;
                    this.emit('agent-token-ready', { broker: 'stockbit', token });
                }
            }

            return token;
        } catch (err) {
            console.error(`[TOKEN-ENGINE] Error extracting ${broker} agent token:`, err.message);
            return null;
        }
    }

    /** @returns {string|null} */
    getPublicToken() {
        return this.state.public;
    }

    /** @param {'ipot'|'stockbit'} broker */
    getAgentToken(broker) {
        return broker === 'ipot' ? this.state.ipotAgent : this.state.stockbitAgent;
    }

    /**
     * Store sanitized account information (custcode, main account)
     * @param {string} broker
     * @param {Object} info
     * @param {string[]|string} [info.custcodes]
     * @param {string} [info.main]
     */
    setAccountInfo(broker, info = {}) {
        if (!broker) return;
        const key = broker.toLowerCase();
        const custcodes = Array.isArray(info.custcodes)
            ? info.custcodes.map(String).filter(Boolean)
            : info.custcodes ? [String(info.custcodes)] : [];
        const main = info.main ? String(info.main) : (custcodes[0] || null);
        this.accounts[key] = {
            custcodes,
            main,
            updatedAt: Date.now()
        };
        this.emit('account-info-ready', { broker: key, custcodes, main });
    }

    /**
     * Retrieve stored account information for a broker
     * @param {string} broker
     * @returns {{custcodes: string[], main: string|null, updatedAt: number}|null}
     */
    getAccountInfo(broker) {
        if (!broker) return null;
        const key = broker.toLowerCase();
        return this.accounts[key] || null;
    }

    /**
     * Get primary custcode (main account if available)
     * @param {string} broker
     * @returns {string|null}
     */
    getPrimaryCustcode(broker) {
        const info = this.getAccountInfo(broker);
        if (!info) return null;
        if (info.main) return info.main;
        if (Array.isArray(info.custcodes) && info.custcodes.length > 0) {
            return info.custcodes[0];
        }
        return null;
    }

    /**
     * Clear stored account info (e.g., on logout)
     * @param {string} broker
     */
    clearAccountInfo(broker) {
        if (!broker) return;
        const key = broker.toLowerCase();
        delete this.accounts[key];
    }

    /**
     * Mask token for safe logging
     * @param {string} token
     * @returns {string}
     */
    mask(token) {
        if (!token) return '(none)';
        if (token.length > 20) {
            return token.substring(0, 10) + '...' + token.substring(token.length - 10);
        }
        return token.substring(0, 4) + '***';
    }
}

// Singleton
module.exports = new TokenEngine();
