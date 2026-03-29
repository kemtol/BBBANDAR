// preload.js - Sniffer Bridge + WebSocket Interceptor
const { ipcRenderer, contextBridge } = require('electron');

// Intercept WebSocket connections to capture appsession token
const OriginalWebSocket = window.WebSocket || WebSocket;

let socketCounter = 0;
const requestMap = new Map();
const CHECK_INTERVAL = 3000;
const LOGIN_INITIAL_ATTEMPTS = 10;
const LOGIN_CONTINUE_ATTEMPTS = 60;

let currentBroker = 'ipot';
let loginPollTimer = null;
let lastBroadcastState = null;
let loginConfirmed = false;
let pendingLoginConfirm = false;
let pendingLoginSource = null;
let isWarmupActive = false;
let waitingForUserDecision = false;
let tokenSignalSent = false;
let lastAccountInfoHash = null;

// --- WS FRAME DUMP ---
let wsTapActive = true;
let wsTapSeq = 0;

function broadcastLoginLog(level, message) {
    ipcRenderer.send('login-log', {
        broker: currentBroker,
        level,
        message,
        ts: Date.now()
    });
}

function logLogin(message) {
    if (currentBroker === 'ipot') {
        console.log(`[IPOT CLIENT] ${message}`);
    } else {
        console.log(`[${currentBroker.toUpperCase()} CLIENT] ${message}`);
    }
    broadcastLoginLog('info', message);
}

function logLoginError(message) {
    if (currentBroker === 'ipot') {
        console.warn(`[IPOT CLIENT] ${message}`);
    } else {
        console.warn(`[${currentBroker.toUpperCase()} CLIENT] ${message}`);
    }
    broadcastLoginLog('error', message);
}

function relayAccountInfo(accountData) {
    if (!accountData || typeof accountData !== 'object') {
        return;
    }
    const rawList = Array.isArray(accountData.custcode)
        ? accountData.custcode
        : accountData.custcode ? [accountData.custcode] : [];
    const custcodes = rawList
        .map((code) => {
            try {
                return String(code).trim();
            } catch (_) {
                return '';
            }
        })
        .filter(Boolean);

    const payload = {
        broker: currentBroker,
        custcodes,
        main: typeof accountData.main === 'string' ? accountData.main : null,
        name: typeof accountData.name === 'string' ? accountData.name : null,
        lid: typeof accountData.lid === 'string' ? accountData.lid : null
    };

    if (!payload.main && custcodes.length > 0) {
        payload.main = custcodes[0];
    }

    const serialized = JSON.stringify(payload);
    if (serialized === lastAccountInfoHash) {
        return;
    }
    lastAccountInfoHash = serialized;
    ipcRenderer.send('broker-account-info', payload);
}

function makeMapKey(socketId, requestId) {
    return `${socketId}:${requestId}`;
}

function safeJsonParse(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch (_) {
        return null;
    }
}

function handleOutboundMessage(socketId, rawData) {
    const parsed = safeJsonParse(rawData);
    if (!parsed || parsed.event !== 'cmd') {
        return;
    }

    const cid = parsed.cid ?? parsed.data?.cid;
    if (cid === undefined || cid === null) {
        return;
    }

    const service = parsed.data?.param?.service || null;
    const cmd = parsed.data?.param?.cmd || null;

    if (!service || !cmd) {
        return;
    }

    const mapKey = makeMapKey(socketId, cid);
    const isSubscribe = Boolean(
        parsed.data?.param?.subscribe ??
        parsed.data?.param?.param?.subscribe
    );

    requestMap.set(mapKey, {
        service,
        cmd,
        isSubscribe,
        ts: Date.now()
    });

    if (service === 'porto' && cmd === 'MYACCOUNT') {
        logLogin(`Tracking request: service=${service} cmd=${cmd} cid=${cid}`);
    }
}

function handleInboundMessage(socketId, rawData) {
    const parsed = safeJsonParse(rawData);
    if (!parsed) {
        return;
    }

    if (parsed.rid === undefined || parsed.rid === null) {
        return;
    }

    const mapKey = makeMapKey(socketId, parsed.rid);
    const meta = requestMap.get(mapKey);
    if (!meta) {
        return;
    }

    if (!meta.isSubscribe) {
        requestMap.delete(mapKey);
    }

    if (meta.service === 'porto' && meta.cmd === 'MYACCOUNT') {
        const status = parsed.data?.status;
        if (status === 'OK') {
            relayAccountInfo(parsed.data?.data);
            handleLoginConfirmed('MYACCOUNT');
        } else if (status) {
            logLoginError(`MYACCOUNT response status=${status}`);
        }
    }
}

function clearPendingRequests(socketId) {
    const prefix = `${socketId}:`;
    for (const key of Array.from(requestMap.keys())) {
        if (key.startsWith(prefix)) {
            requestMap.delete(key);
        }
    }
}

function instrumentSocket(socket) {
    if (socket.__algoLoginInstrumented) {
        return;
    }

    socket.__algoLoginInstrumented = true;

    const socketId = ++socketCounter;
    socket.__algoSocketId = socketId;

    const originalSend = socket.send.bind(socket);

    socket.send = function patchedSend(data, ...rest) {
        try {
            handleOutboundMessage(socketId, data);
        } catch (err) {
            logLoginError(`Failed parsing outbound frame: ${err.message}`);
        }
        if (wsTapActive) {
            if (wsTapSeq === 0) console.log('[PRELOAD] WS tap: sending first SEND frame');
            ipcRenderer.send('ws-frame-dump', {
                seq: ++wsTapSeq,
                dir: 'SEND',
                socketId,
                url: socket.__algoWsUrl || null,
                ts: Date.now(),
                raw: typeof data === 'string' ? data : null
            });
        }
        return originalSend(data, ...rest);
    };

    socket.addEventListener('message', (event) => {
        try {
            handleInboundMessage(socketId, event.data);
        } catch (err) {
            logLoginError(`Failed parsing inbound frame: ${err.message}`);
        }
        if (wsTapActive) {
            ipcRenderer.send('ws-frame-dump', {
                seq: ++wsTapSeq,
                dir: 'RECV',
                socketId,
                url: socket.__algoWsUrl || null,
                ts: Date.now(),
                raw: typeof event.data === 'string' ? event.data : null
            });
        }
    });

    socket.addEventListener('close', () => clearPendingRequests(socketId));
    socket.addEventListener('error', () => clearPendingRequests(socketId));
}

const _WS = function (url, protocols) {
    if (typeof url === 'string' && url.includes('appsession=')) {
        try {
            const urlObj = new URL(url);
            const token = urlObj.searchParams.get('appsession');
            if (token) {
                console.log('[PRELOAD] 🔑 Captured appsession from WebSocket URL');
                ipcRenderer.send('ws-token-captured', token);
            }
        } catch (e) {
            const match = url.match(/appsession=([^&]+)/);
            if (match) {
                console.log('[PRELOAD] 🔑 Captured appsession (regex fallback)');
                ipcRenderer.send('ws-token-captured', match[1]);
            }
        }
    }

    const socket = new OriginalWebSocket(url, protocols);
    socket.__algoWsUrl = (() => {
        try {
            const raw = typeof url === 'string' ? url : String(url);
            return raw.replace(/appsession=[^&\s#]+/g, 'appsession=***');
        } catch (_) { return null; }
    })();
    try {
        instrumentSocket(socket);
    } catch (err) {
        logLoginError(`Instrumentation error: ${err.message}`);
    }
    return socket;
};

_WS.prototype = OriginalWebSocket.prototype;
_WS.CONNECTING = OriginalWebSocket.CONNECTING;
_WS.OPEN = OriginalWebSocket.OPEN;
_WS.CLOSING = OriginalWebSocket.CLOSING;
_WS.CLOSED = OriginalWebSocket.CLOSED;
window.WebSocket = _WS;

// --- HTTP (XHR/Fetch) INTERCEPTOR for order placement ---
const OriginalXHR = window.XMLHttpRequest;
const OriginalFetch = window.fetch;

const _XHR = function () {
    const xhr = new OriginalXHR();
    let _method = '';
    let _url = '';
    let _body = null;

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
        _method = method;
        _url = typeof url === 'string' ? url : String(url);
        return origOpen(method, url, ...rest);
    };

    const origSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
        _body = body;
        if (wsTapActive && _url && !_url.includes('/socketcluster/')) {
            ipcRenderer.send('ws-frame-dump', {
                seq: ++wsTapSeq,
                dir: 'HTTP_SEND',
                socketId: 0,
                ts: Date.now(),
                raw: JSON.stringify({
                    method: _method,
                    url: _url.replace(/appsession=[^&\s#]+/g, 'appsession=***'),
                    body: typeof body === 'string' ? body : null
                })
            });
        }
        return origSend(body);
    };

    return xhr;
};
_XHR.prototype = OriginalXHR.prototype;
Object.keys(OriginalXHR).forEach(k => { _XHR[k] = OriginalXHR[k]; });
window.XMLHttpRequest = _XHR;

window.fetch = function (input, init) {
    if (wsTapActive) {
        const url = typeof input === 'string' ? input
            : input instanceof Request ? input.url : String(input);
        if (!url.includes('/socketcluster/')) {
            const method = (init && init.method) || 'GET';
            let body = null;
            if (init && init.body && typeof init.body === 'string') {
                body = init.body;
            }
            ipcRenderer.send('ws-frame-dump', {
                seq: ++wsTapSeq,
                dir: 'HTTP_SEND',
                socketId: 0,
                ts: Date.now(),
                raw: JSON.stringify({
                    method,
                    url: url.replace(/appsession=[^&\s#]+/g, 'appsession=***'),
                    body
                })
            });
        }
    }
    return OriginalFetch.apply(this, arguments);
};

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
            logLoginError(`Failed reading localStorage: ${err.message}`);
            return false;
        }
    }
};

function emitLoginState(loggedIn, source) {
    if (!isWarmupActive) {
        return;
    }
    if (lastBroadcastState === loggedIn && loggedIn !== false) {
        return;
    }
    lastBroadcastState = loggedIn;
    ipcRenderer.send('broker-login-state', {
        broker: currentBroker,
        loggedIn,
        source,
        ts: Date.now()
    });
}

function handleLoginConfirmed(source) {
    if (!isWarmupActive) {
        pendingLoginConfirm = true;
        pendingLoginSource = source;
        return;
    }
    if (!loginConfirmed) {
        loginConfirmed = true;
        tokenSignalSent = true;
        logLogin('Login confirmed via MYACCOUNT');
        emitLoginState(true, source);
    }
}

function clearLoginTimer() {
    if (loginPollTimer) {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
    }
}

function startLoginListener(broker, maxAttempts = LOGIN_INITIAL_ATTEMPTS) {
    clearLoginTimer();

    const hadPendingConfirm = pendingLoginConfirm;
    const pendingSource = pendingLoginSource;

    currentBroker = broker || 'ipot';
    loginConfirmed = false;
    pendingLoginConfirm = false;
    pendingLoginSource = null;
    lastBroadcastState = null;
    waitingForUserDecision = false;
    tokenSignalSent = false;
    lastAccountInfoHash = null;
    requestMap.clear();

    if (maxAttempts === LOGIN_INITIAL_ATTEMPTS) {
        logLogin('Waiting for login... polling every 3s');
    } else {
        logLogin(`Continuing to wait for login (max ${maxAttempts} attempts)`);
    }
    emitLoginState(false, 'INIT');

    const checker = BROKER_LOGIN_CHECKS[currentBroker];
    if (!checker) {
        logLoginError(`No login checker registered for broker ${currentBroker}`);
        return;
    }

    let attemptCount = 0;

    loginPollTimer = setInterval(() => {
        if (waitingForUserDecision) {
            return;
        }

        let hasToken = false;
        try {
            hasToken = Boolean(checker());
        } catch (err) {
            logLoginError(`Token check failed: ${err.message}`);
        }

        if (hasToken) {
            attemptCount = 0;
            if (!tokenSignalSent && !loginConfirmed) {
                tokenSignalSent = true;
                logLogin('Appsession token detected. Awaiting portfolio handshake (MYACCOUNT)...');
                emitLoginState(true, 'TOKEN');
            }
            return;
        }

        tokenSignalSent = false;

        if (loginConfirmed || lastBroadcastState === true) {
            loginConfirmed = false;
            attemptCount = 0;
            logLogin('Session ended (token missing)');
            emitLoginState(false, 'TOKEN_CHECK');
            return;
        }

        attemptCount += 1;
        logLogin(`Waiting for login... (${attemptCount}/${maxAttempts}) 3s`);

        if (attemptCount >= maxAttempts && !waitingForUserDecision) {
            waitingForUserDecision = true;
            logLoginError('Login timeout reached. Awaiting user decision.');
            emitLoginState(false, 'TIMEOUT_PENDING');
            clearLoginTimer();
            ipcRenderer.send('login-timeout', {
                broker: currentBroker,
                attempts: attemptCount,
                maxAttempts
            });
        }
    }, CHECK_INTERVAL);

    if (hadPendingConfirm) {
        handleLoginConfirmed(pendingSource || 'MYACCOUNT');
    }
}

function handleBrokerSwitch(broker) {
    currentBroker = broker || 'ipot';
    lastAccountInfoHash = null;
    if (isWarmupActive) {
        logLogin(`Broker switched to ${currentBroker.toUpperCase()}, restarting login listener`);
        startLoginListener(currentBroker);
    }
}

ipcRenderer.on('warmup-ready', (event, payload = {}) => {
    const broker = payload.broker || currentBroker;
    isWarmupActive = true;
    startLoginListener(broker);
});

ipcRenderer.on('switch-broker', (event, broker) => {
    handleBrokerSwitch(broker);
});

ipcRenderer.on('login-timeout-response', (event, payload = {}) => {
    const action = (payload.action || '').toLowerCase();
    if (!isWarmupActive) {
        return;
    }

    if (action === 'continue') {
        waitingForUserDecision = false;
        logLogin(`User opted to continue monitoring login (max ${LOGIN_CONTINUE_ATTEMPTS} attempts).`);
        startLoginListener(currentBroker, LOGIN_CONTINUE_ATTEMPTS);
    } else if (action === 'close') {
        logLoginError('User chose to close application after login timeout.');
        window.close();
    }
});

ipcRenderer.on('ws-tap-toggle', (event, enabled) => {
    wsTapActive = Boolean(enabled);
    console.log(`[PRELOAD] WS tap ${wsTapActive ? 'ENABLED' : 'DISABLED'}`);
});

window.addEventListener('beforeunload', () => {
    clearLoginTimer();
    requestMap.clear();
    loginConfirmed = false;
    pendingLoginConfirm = false;
    pendingLoginSource = null;
    lastBroadcastState = null;
    lastAccountInfoHash = null;
});
