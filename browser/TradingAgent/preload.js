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
