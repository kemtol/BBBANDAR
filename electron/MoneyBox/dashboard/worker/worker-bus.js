/**
 * worker-bus.js  (main thread — NOT a Web Worker)
 * Central broker that boots all workers, wires their messages together,
 * and exposes a simple subscribe/publish API to the dashboard UI.
 *
 * Usage (in home.html / index.html):
 *   <script type="module" src="worker/worker-bus.js"></script>
 *
 * Then anywhere in the UI:
 *   import { bus } from './worker/worker-bus.js';
 *
 *   bus.on('metrics', payload => updateAgentCards(payload));
 *   bus.on('qdrant',  payload => updateRAGTable(payload));
 *   bus.on('logs',    lines   => appendLogRows(lines));
 *   bus.on('error',   err     => console.warn('[worker]', err));
 *
 * Config — edit the constants below to point at your VPS:
 */

// ── Config ─────────────────────────────────────────
const DISPATCHER_BASE = '/api/dispatcher';
const QDRANT_BASE     = '/api/qdrant';

const POLL_METRICS = 5_000;   // ms
const POLL_QDRANT  = 30_000;  // ms
const POLL_LOGS    = 3_000;   // ms

// ── Boot workers ───────────────────────────────────
const metricsWorker = new Worker(new URL('./metrics-worker.js', import.meta.url));
const qdrantWorker  = new Worker(new URL('./qdrant-worker.js',  import.meta.url));
const logWorker     = new Worker(new URL('./log-worker.js',     import.meta.url));
const notifWorker   = new Worker(new URL('./notif-worker.js',   import.meta.url));

// ── Pub/Sub bus ────────────────────────────────────
const _handlers = {};

export const bus = {
  on(event, fn) {
    (_handlers[event] ??= []).push(fn);
  },
  off(event, fn) {
    _handlers[event] = (_handlers[event] ?? []).filter(h => h !== fn);
  },
  _emit(event, data) {
    (_handlers[event] ?? []).forEach(fn => fn(data));
  },
};

// ── Wire worker → bus ──────────────────────────────
function wire(worker) {
  worker.addEventListener('message', e => {
    const { type, ...rest } = e.data;
    bus._emit(type, rest);
    // Also forward metrics & logs to notif worker
    if (type === 'metrics' || type === 'logs') notifWorker.postMessage(e.data);
  });
  worker.addEventListener('error', err => {
    bus._emit('error', { message: err.message });
  });
}

wire(metricsWorker);
wire(qdrantWorker);
wire(logWorker);
wire(notifWorker);

// ── Handle notification requests on main thread ────
bus.on('notify', ({ title, body }) => {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '../img/icon.png' });
  }
});

// ── Request notification permission ───────────────
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ── Start polling ──────────────────────────────────
metricsWorker.postMessage({ type: 'start', url: `${DISPATCHER_BASE}/metrics`, interval: POLL_METRICS });
qdrantWorker.postMessage({  type: 'start', baseUrl: QDRANT_BASE,              interval: POLL_QDRANT  });
logWorker.postMessage({     type: 'start', url: `${DISPATCHER_BASE}/logs`,    interval: POLL_LOGS    });
