/**
 * features.js
 * Mengambil fitur market harian (mis. target price analis broker)
 * dari WebSocket IPOT (SocketCluster) untuk semua emiten.
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const MASTER_EMITEN_PATH = path.join(__dirname, '../../data/master-emiten.json');
const OUTPUT_PATH = path.join(__dirname, '../../data/features-emiten.json');

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
        console.error('[FEATURES] Error loading emiten list:', err.message);
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
 * Connect to WebSocket and fetch target prices for all emitens
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

        log(`[FEATURES] Connecting to WebSocket...`);
        log(`[FEATURES] Total emitens to query: ${emitens.length}`);

        const ws = new WebSocket(wsUrl);
        const results = {};
        const pendingQueries = new Map();
        const dateStr = getTodayDate();
        let currentIndex = 0;
        let cidCounter = 1;

        function computeAvgTarget(payload) {
            try {
                const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.data) ? payload.data : null);
                if (!rows) return null;
                let sum = 0, cnt = 0;
                for (const it of rows) {
                    if (!it || typeof it !== 'object') continue;
                    const candidates = [it.average, it.avg, it.target, it.targetPrice, it.tp, it.value, it.price];
                    let picked = null;
                    for (const v of candidates) {
                        const num = typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : NaN);
                        if (!isNaN(num) && isFinite(num) && num > 0) { picked = num; break; }
                    }
                    if (picked !== null) { sum += picked; cnt++; }
                }
                if (cnt > 0) return sum / cnt;
                return null;
            } catch (_) { return null; }
        }


        // Timeout: kill connection if it takes too long
        const globalTimeout = setTimeout(() => {
            log(`[FEATURES] ⚠️ Global timeout reached. Saving ${Object.keys(results).length} results.`);
            ws.close();
            saveResults(results);
            resolve(results);
        }, emitens.length * (QUERY_DELAY_MS + 500) + 30000); // generous timeout

        ws.on('open', () => {
            log(`[FEATURES] ✅ WebSocket connected.`);
            log(`[FEATURES] Handshaking`);

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
                    log(`[FEATURES] ✅ All queries complete. Total results: ${Object.keys(results).length}/${emitens.length}`);
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

            if (ticker === 'BBRI') {
                log(`[FEATURES] Checking for BBRI target price average`);
            }
            ws.send(JSON.stringify(msg));

            if (currentIndex % 20 === 0) {
                log(`[FEATURES] 📡 Querying... ${currentIndex + 1}/${emitens.length} (${ticker})`);
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

                // Handshake acknowledgements
                if (msg.event === '#handshake' || msg.event === '#setAuthToken') {
                    log(`[FEATURES] Handshake ack: ${msg.event}`);
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

                            const avg = computeAvgTarget(msg.data.data);
                            if (avg !== null) {
                                results[ticker].avgTarget = avg;
                                if (ticker === 'BBRI') {
                                    log(`[FEATURES] BBRI target price average by broker is ${avg.toFixed(2)}`);
                                }
                                log(`[FEATURES] adding today average price target to emiten data`);
                            }
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

                            const avg = computeAvgTarget(msg.data || null);
                            if (avg !== null) {
                                results[ticker].avgTarget = avg;
                                if (ticker === 'BBRI') {
                                    log(`[FEATURES] BBRI target price average by broker is ${avg.toFixed(2)}`);
                                }
                                log(`[FEATURES] adding today average price target to emiten data`);
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors for binary frames or pings
            }
        });

        ws.on('error', (err) => {
            log(`[FEATURES] ❌ WebSocket error: ${err.message}`);
            clearTimeout(globalTimeout);
            reject(err);
        });

        ws.on('close', (code, reason) => {
            log(`[FEATURES] WebSocket closed. Code: ${code}`);
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
        console.log(`[FEATURES] 💾 Saved to ${OUTPUT_PATH}`);
    } catch (err) {
        console.error('[FEATURES] Error saving results:', err.message);
    }
}

module.exports = {
    connectAndFetch,
    saveResults,
    loadEmitenList
};
