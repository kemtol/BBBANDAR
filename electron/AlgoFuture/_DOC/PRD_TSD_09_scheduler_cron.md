# PRD & TSD — Scheduler & Cron Jobs

## PRD

### Objective
Automate routine jobs: morning reset, pre-close force-flatten, heartbeat and optional EOD reconciliation.

### Success Metrics
- Jobs execute at configured local timezone times reliably
- Force-flatten reliably triggers executor flatten flow at scheduled time

### Stakeholders
- Operations, Risk

---

## TSD

### Jobs (example)
- Morning Reset: 08:50 WIB (Mon-Fri) — reset daily metrics
- Force Flatten: 15:48 WIB (Mon-Fri) — attempt to flatten positions
- Heartbeat: every 5 minutes — system health
- EOD Reconcile: after close — persist daily P&L

### Implementation
- Use `node-cron` with proper timezone handling
- `cron/scheduler.js` registers jobs and exposes hooks to `main.js`
- Jobs communicate via module API (e.g., `compliance.onNewTradingDay()` / `executor.flattenAll()`)

### Tests
- Time-mocking tests to verify job triggers

### Effort Estimate
0.5–1 day
