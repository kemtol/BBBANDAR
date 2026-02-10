/**
 * token-engine.js — Centralized Token State Manager
 * 
 * 3-Tier Token Architecture:
 * 1. Public Token  — Auto (just opening IPOT page), for backtest/dry run/chart
 * 2. IPOT Agent    — After IPOT login, for real trade execution
 * 3. Stockbit Agent — After Stockbit login, for real trade execution
 */
const EventEmitter = require('events');

class TokenEngine extends EventEmitter {
    constructor() {
        super();
        this.state = {
            public: null,        // Public token (no login needed)
            ipotAgent: null,     // IPOT authenticated token
            stockbitAgent: null  // Stockbit authenticated token
        };
    }

    /**
     * Extract PUBLIC token from IPOT page (no login required).
     * This token is available just by opening the IPOT page.
     * Used for: backtest, dry run, chart data, target prices.
     * CANNOT execute trades.
     * 
     * @param {Electron.WebContents} webContents - Left pane webContents
     * @returns {Promise<string|null>}
     */
    async extractPublicToken(webContents) {
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
                        var v = localStorage.getItem(keys[i]);
                        if (v) return v;
                    }
                    for (var i = 0; i < keys.length; i++) {
                        var v = sessionStorage.getItem(keys[i]);
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
