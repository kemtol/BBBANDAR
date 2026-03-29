/**
 * log-worker.js
 * Tails agent log files by polling dispatcher /logs endpoint
 * and posts new lines to the main thread as a ring-buffer.
 *
 * Main thread usage:
 *   const w = new Worker('worker/log-worker.js');
 *   w.postMessage({ type: 'start', url: 'http://VPS_IP:19191/logs', interval: 3000, maxLines: 200 });
 *   w.addEventListener('message', e => { if (e.data.type === 'logs') appendLog(e.data.lines); });
 *
 * Expected GET /logs?since=TIMESTAMP response shape:
 * {
 *   "lines": [
 *     { "ts": "2026-03-13T10:14:51Z", "agent": "main",   "level": "INFO", "msg": "heartbeat fired" },
 *     { "ts": "2026-03-13T10:14:52Z", "agent": "ditesh", "level": "WARN", "msg": "compact skipped" }
 *   ]
 * }
 *
 * Falls back to full fetch (no ?since param) if endpoint does not support it.
 */

let _timer    = null;
let _url      = null;
let _interval = 3_000;
let _maxLines = 200;
let _lastTs   = null;

self.addEventListener('message', e => {
  const { type, url, interval, maxLines } = e.data ?? {};

  if (type === 'start') {
    _url      = url      ?? _url;
    _interval = interval ?? _interval;
    _maxLines = maxLines ?? _maxLines;
    _lastTs   = null;
    clearInterval(_timer);
    poll();
    _timer = setInterval(poll, _interval);

  } else if (type === 'stop') {
    clearInterval(_timer);
    _timer = null;
  } else if (type === 'clear') {
    _lastTs = null;
  }
});

async function poll() {
  if (!_url) return;
  try {
    const endpoint = _lastTs ? `${_url}?since=${encodeURIComponent(_lastTs)}` : _url;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const lines = body.lines ?? [];
    if (lines.length > 0) {
      _lastTs = lines[lines.length - 1].ts;
      // Truncate to ring-buffer size before sending
      const trimmed = lines.slice(-_maxLines);
      self.postMessage({ type: 'logs', lines: trimmed, ts: Date.now() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', source: 'logs', message: err.message, ts: Date.now() });
  }
}
