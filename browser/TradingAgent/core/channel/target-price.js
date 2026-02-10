/**
 * target-price.js
 * Menyadap data Target Price dari WebSocket IPOT (SocketCluster)
 * untuk semua emiten dalam master list.
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const MASTER_EMITEN_PATH = path.join(__dirname, '../../data/master-emiten.json');
const OUTPUT_PATH = path.join(__dirname, '../../data/target-price-by-emiten.json');

// Delay between each emiten query to avoid flooding
const QUERY_DELAY_MS = 300;

// NOTE: Token extraction is now handled by core/engine/token-engine.js


/**
 * Load master emiten list
 * @returns {string[]} Array of ticker symbols (without .JK suffix)
 */
function loadEmitenList() {
    try {
        const raw = fs.readFileSync(MASTER_EMITEN_PATH, 'utf8');
        const list = JSON.parse(raw);
        return list.map(e => e.ticker.replace('.JK', ''));
    } catch (err) {
        console.error('[TARGET-PRICE] Error loading emiten list:', err.message);
        return [];
    }
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Connect to IPOT WebSocket and fetch target prices for all emitens
 * @param {string} token - The appsession token
 * @param {Function} logFn - Optional logging function to send updates to UI
 * @returns {Promise<Object>} Results keyed by ticker
 */
function connectAndFetch(token, logFn) {
    return new Promise((resolve, reject) => {
        const emitens = loadEmitenList();
        if (emitens.length === 0) {
            reject(new Error('No emitens loaded from master list.'));
            return;
        }

        const wsUrl = `wss://ipotapp.ipot.id/socketcluster/?appsession=${token}`;
        const log = logFn || console.log;

        log(`[TARGET-PRICE] Connecting to IPOT WebSocket...`);
        log(`[TARGET-PRICE] Total emitens to query: ${emitens.length}`);

        const ws = new WebSocket(wsUrl);
        const results = {};
        let currentIndex = 0;
        let cidCounter = 1;
        const pendingQueries = new Map(); // cid -> ticker
        const dateStr = getTodayDate();

        // Timeout: kill connection if it takes too long
        const globalTimeout = setTimeout(() => {
            log(`[TARGET-PRICE] ⚠️ Global timeout reached. Saving ${Object.keys(results).length} results.`);
            ws.close();
            saveResults(results);
            resolve(results);
        }, emitens.length * (QUERY_DELAY_MS + 500) + 30000); // generous timeout

        ws.on('open', () => {
            log(`[TARGET-PRICE] ✅ WebSocket connected.`);

            // SocketCluster handshake
            ws.send(JSON.stringify({
                event: '#handshake',
                data: { authToken: null },
                cid: cidCounter++
            }));

            // Start querying after a short delay for handshake
            setTimeout(() => {
                sendNextQuery();
            }, 500);
        });

        function sendNextQuery() {
            if (currentIndex >= emitens.length) {
                // All queries sent, wait a bit for remaining responses
                setTimeout(() => {
                    log(`[TARGET-PRICE] ✅ All queries complete. Total results: ${Object.keys(results).length}/${emitens.length}`);
                    clearTimeout(globalTimeout);
                    ws.close();
                    saveResults(results);
                    resolve(results);
                }, 3000);
                return;
            }

            const ticker = emitens[currentIndex];
            const cid = cidCounter++;
            pendingQueries.set(cid, ticker);

            const msg = {
                event: 'cmd',
                data: {
                    cmdid: 2,
                    param: {
                        cmd: 'query',
                        service: 'midata',
                        param: {
                            source: 'datafeed',
                            index: 'en_qu_TargetPrice',
                            args: [ticker, dateStr]
                        }
                    }
                },
                cid: cid
            };

            ws.send(JSON.stringify(msg));

            if (currentIndex % 20 === 0) {
                log(`[TARGET-PRICE] 📡 Querying... ${currentIndex + 1}/${emitens.length} (${ticker})`);
            }

            currentIndex++;

            // Stagger queries to avoid rate limiting
            setTimeout(sendNextQuery, QUERY_DELAY_MS);
        }

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());

                // Handle SocketCluster ping/pong
                if (raw.toString() === '') return;
                if (raw.toString() === '#1') {
                    ws.send('#2'); // pong
                    return;
                }

                // Handle query responses
                if (msg.rid) {
                    const ticker = pendingQueries.get(msg.rid);
                    if (ticker) {
                        pendingQueries.delete(msg.rid);

                        if (msg.data && msg.data.data) {
                            results[ticker] = {
                                data: msg.data.data,
                                fetchedAt: new Date().toISOString()
                            };
                        } else if (msg.error) {
                            results[ticker] = {
                                error: msg.error,
                                fetchedAt: new Date().toISOString()
                            };
                        } else {
                            results[ticker] = {
                                data: msg.data || null,
                                fetchedAt: new Date().toISOString()
                            };
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors for binary frames or pings
            }
        });

        ws.on('error', (err) => {
            log(`[TARGET-PRICE] ❌ WebSocket error: ${err.message}`);
            clearTimeout(globalTimeout);
            reject(err);
        });

        ws.on('close', (code, reason) => {
            log(`[TARGET-PRICE] WebSocket closed. Code: ${code}`);
            clearTimeout(globalTimeout);
        });
    });
}

/**
 * Save results to JSON file
 * @param {Object} data - Results keyed by ticker
 */
function saveResults(data) {
    try {
        const output = {
            generatedAt: new Date().toISOString(),
            totalEmitens: Object.keys(data).length,
            results: data
        };
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
        console.log(`[TARGET-PRICE] 💾 Saved to ${OUTPUT_PATH}`);
    } catch (err) {
        console.error('[TARGET-PRICE] Error saving results:', err.message);
    }
}

module.exports = {
    connectAndFetch,
    saveResults,
    loadEmitenList
};
