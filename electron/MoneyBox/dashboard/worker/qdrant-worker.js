/**
 * qdrant-worker.js
 * Polls the Qdrant REST API for per-agent collection stats every N seconds
 * and posts the parsed result back to the main thread.
 *
 * Main thread usage:
 *   const w = new Worker('worker/qdrant-worker.js');
 *   w.postMessage({ type: 'start', baseUrl: 'http://VPS_IP:6333', interval: 30000 });
 *   w.addEventListener('message', e => { if (e.data.type === 'qdrant') updateRAG(e.data.payload); });
 *
 * Collections monitored (per-agent architecture):
 *   agent_memory_main | agent_memory_elsa | agent_memory_ditesh | agent_memory_newton
 *
 * Qdrant GET /collections/{name} response shape (relevant fields):
 * {
 *   "result": {
 *     "status":         "green",
 *     "vectors_count":  1042,
 *     "points_count":   1042,
 *     "segments_count": 3,
 *     "disk_data_size": 2097152
 *   }
 * }
 */

const COLLECTIONS = [
  'agent_memory_main',
  'agent_memory_elsa',
  'agent_memory_ditesh',
  'agent_memory_newton',
];

let _timer    = null;
let _baseUrl  = null;
let _interval = 30_000;

self.addEventListener('message', e => {
  const { type, baseUrl, interval } = e.data ?? {};

  if (type === 'start') {
    _baseUrl  = baseUrl  ?? _baseUrl;
    _interval = interval ?? _interval;
    clearInterval(_timer);
    poll();
    _timer = setInterval(poll, _interval);

  } else if (type === 'stop') {
    clearInterval(_timer);
    _timer = null;
  }
});

async function poll() {
  if (!_baseUrl) return;
  const results = {};

  await Promise.allSettled(
    COLLECTIONS.map(async name => {
      try {
        const res = await fetch(`${_baseUrl}/collections/${name}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) {
          results[name] = { status: 'missing', vectors_count: 0, points_count: 0 };
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        results[name] = body.result ?? {};
      } catch (err) {
        results[name] = { status: 'error', error: err.message };
      }
    })
  );

  self.postMessage({ type: 'qdrant', payload: results, ts: Date.now() });
}
