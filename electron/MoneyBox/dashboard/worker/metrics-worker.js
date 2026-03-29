/**
 * metrics-worker.js
 * Polls the dispatcher /metrics endpoint every N seconds and posts
 * the parsed result back to the main thread.
 *
 * Main thread usage:
 *   const w = new Worker('worker/metrics-worker.js');
 *   w.postMessage({ type: 'start', url: 'http://VPS_IP:19191/metrics', interval: 5000 });
 *   w.addEventListener('message', e => { if (e.data.type === 'metrics') updateUI(e.data.payload); });
 *   w.postMessage({ type: 'stop' }); // to halt polling
 *
 * Expected /metrics response shape (dispatcher v5):
 * {
 *   "agents": {
 *     "main":   { "session_count": 12, "heartbeat_last": "2026-03-13T10:00:00Z", "compact_last": "2026-03-13T09:15:00Z" },
 *     "elsa":   { ... },
 *     "ditesh": { ... },
 *     "newton": { ... }
 *   },
 *   "uptime_seconds": 86400,
 *   "thread_count":   5
 * }
 */

let _timer   = null;
let _url     = null;
let _interval = 5000;

self.addEventListener('message', e => {
  const { type, url, interval } = e.data ?? {};

  if (type === 'start') {
    _url      = url      ?? _url;
    _interval = interval ?? _interval;
    clearInterval(_timer);
    poll(); // immediate first fetch
    _timer = setInterval(poll, _interval);

  } else if (type === 'stop') {
    clearInterval(_timer);
    _timer = null;
  }
});

async function poll() {
  if (!_url) return;
  try {
    const res = await fetch(_url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    self.postMessage({ type: 'metrics', payload, ts: Date.now() });
  } catch (err) {
    self.postMessage({ type: 'error', source: 'metrics', message: err.message, ts: Date.now() });
  }
}
