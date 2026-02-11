// preload.js - Sniffer Bridge + WebSocket Interceptor
const { ipcRenderer, contextBridge } = require('electron');

// Intercept WebSocket connections to capture appsession token
const OriginalWebSocket = window.WebSocket || WebSocket;
const _WS = function (url, protocols) {
    // Extract appsession from WebSocket URL
    if (typeof url === 'string' && url.includes('appsession=')) {
        try {
            const urlObj = new URL(url);
            const token = urlObj.searchParams.get('appsession');
            if (token) {
                console.log('[PRELOAD] 🔑 Captured appsession from WebSocket URL');
                ipcRenderer.send('ws-token-captured', token);
            }
        } catch (e) {
            // Fallback regex extraction
            const match = url.match(/appsession=([^&]+)/);
            if (match) {
                console.log('[PRELOAD] 🔑 Captured appsession (regex fallback)');
                ipcRenderer.send('ws-token-captured', match[1]);
            }
        }
    }
    return new OriginalWebSocket(url, protocols);
};
_WS.prototype = OriginalWebSocket.prototype;
_WS.CONNECTING = OriginalWebSocket.CONNECTING;
_WS.OPEN = OriginalWebSocket.OPEN;
_WS.CLOSING = OriginalWebSocket.CLOSING;
_WS.CLOSED = OriginalWebSocket.CLOSED;
window.WebSocket = _WS;

// Data sniffer bridge
contextBridge.exposeInMainWorld('sniffer', {
    sendData: (type, payload) => ipcRenderer.send('raw-data', { type, payload })
});

console.log("[PRELOAD] Sniffer Bridge + WS Interceptor Initialized");

const BROKER_LOGIN_CHECKS = {
    ipot: () => {
        try {
            const token = window.localStorage?.getItem('appsession');
            return Boolean(token && token.length >= 20);
        } catch (err) {
            console.warn('[PRELOAD] Failed reading IPOT login token:', err.message);
            return false;
        }
    }
};

let currentBroker = 'ipot';
let loginPollTimer = null;
let lastLoggedInStatus = null;
let isWarmupActive = false;

function clearLoginTimer() {
    if (loginPollTimer) {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
    }
}

function startLoginListener(broker) {
    clearLoginTimer();

    const checker = BROKER_LOGIN_CHECKS[broker];
    if (!checker) {
        console.warn(`[PRELOAD] No login checker registered for broker ${broker}`);
        return;
    }

    console.log(`[LISTEN LOGIN ${broker.toUpperCase()}] Waiting user to login`);
    loginPollTimer = setInterval(() => {
        const loggedIn = Boolean(checker());
        if (loggedIn !== lastLoggedInStatus) {
            lastLoggedInStatus = loggedIn;
            if (loggedIn) {
                console.log(`[LISTEN LOGIN ${broker.toUpperCase()}] Login detected. Bot disable agent start button OFF`);
            }
            ipcRenderer.send('broker-login-state', {
                broker,
                loggedIn,
                ts: Date.now()
            });
        }
    }, 4000);

    // Run immediately once
    const initialLoggedIn = Boolean(checker());
    lastLoggedInStatus = initialLoggedIn;
    ipcRenderer.send('broker-login-state', {
        broker,
        loggedIn: initialLoggedIn,
        ts: Date.now()
    });
}

ipcRenderer.on('warmup-ready', (event, payload = {}) => {
    const broker = payload.broker || currentBroker;
    if (isWarmupActive) {
        return;
    }

    isWarmupActive = true;
    currentBroker = broker;
    console.log(`[WARMUP] Warmup ready received (broker=${broker})`);
    startLoginListener(broker);
});

ipcRenderer.on('switch-broker', (event, broker) => {
    currentBroker = broker || 'ipot';
    lastLoggedInStatus = null;
    if (isWarmupActive) {
        startLoginListener(currentBroker);
    }
});

window.addEventListener('beforeunload', () => {
    clearLoginTimer();
});
