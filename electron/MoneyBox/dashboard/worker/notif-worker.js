/**
 * notif-worker.js
 * Watches incoming agent events (from metrics / logs) and emits
 * browser Notification API alerts when thresholds are crossed.
 *
 * Main thread usage:
 *   const w = new Worker('worker/notif-worker.js');
 *   // Feed this worker data from the other workers:
 *   metricsWorker.addEventListener('message', e => { if (e.data.type === 'metrics') notifWorker.postMessage(e.data); });
 *   logWorker.addEventListener('message',     e => { if (e.data.type === 'logs')    notifWorker.postMessage(e.data); });
 *   // Configure rules:
 *   w.postMessage({ type: 'config', rules: DEFAULT_RULES });
 *
 * Note: Notifications are fired from the main thread (Workers cannot call
 * the Notification API directly). This worker posts { type: 'notify', ... }
 * messages back; the main thread calls `new Notification(...)`.
 *
 * Default alert rules (configurable):
 *   - Agent missed heartbeat > 90 minutes
 *   - Agent session count delta > 20 in one poll cycle
 *   - Log line contains level "ERROR" or "CRITICAL"
 */

const DEFAULT_RULES = {
  heartbeat_stale_minutes: 90,
  session_spike_delta:     20,
  log_levels:              ['ERROR', 'CRITICAL'],
};

let _rules = { ...DEFAULT_RULES };

// Track previous metrics to detect deltas
const _prev = {};

self.addEventListener('message', e => {
  const { type } = e.data ?? {};

  if (type === 'config') {
    _rules = { ...DEFAULT_RULES, ...(e.data.rules ?? {}) };

  } else if (type === 'metrics') {
    checkMetrics(e.data.payload);

  } else if (type === 'logs') {
    checkLogs(e.data.lines);
  }
});

// ── Metrics checks ─────────────────────────────────
function checkMetrics(payload) {
  const agents = payload?.agents ?? {};
  const now = Date.now();

  for (const [name, stats] of Object.entries(agents)) {
    // Stale heartbeat check
    if (stats.heartbeat_last) {
      const lastMs  = new Date(stats.heartbeat_last).getTime();
      const staleMs = _rules.heartbeat_stale_minutes * 60 * 1000;
      if (now - lastMs > staleMs) {
        notify(
          `⚠️ Agent ${name}: stale heartbeat`,
          `Last heartbeat was ${Math.round((now - lastMs) / 60000)} min ago.`,
          'warning'
        );
      }
    }

    // Session count spike check
    const prev = _prev[name];
    if (prev != null && stats.session_count != null) {
      const delta = stats.session_count - prev;
      if (delta > _rules.session_spike_delta) {
        notify(
          `📈 Agent ${name}: session spike +${delta}`,
          `Session count jumped from ${prev} to ${stats.session_count}.`,
          'info'
        );
      }
    }
    if (stats.session_count != null) _prev[name] = stats.session_count;
  }
}

// ── Log checks ─────────────────────────────────────
function checkLogs(lines = []) {
  for (const line of lines) {
    if (_rules.log_levels.includes(line.level?.toUpperCase())) {
      notify(
        `🚨 [${line.agent ?? 'agent'}] ${line.level}`,
        line.msg ?? '(no message)',
        'error'
      );
    }
  }
}

// ── Emit ───────────────────────────────────────────
function notify(title, body, severity = 'info') {
  self.postMessage({ type: 'notify', title, body, severity, ts: Date.now() });
}
