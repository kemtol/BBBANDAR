# PRD & TSD — Topstep Auth (Token Extraction / RPA)

## PRD

### Objective
Securely obtain and refresh Topstep ProjectX `access_token` after user login in the left-pane (or via RPA), and provide token events for adapters.

### Success Metrics
- Token extraction success ≥ 98% when user logs in via UI
- Automatic refresh workflow available via headless RPA when needed

### Stakeholders
- Topstep SignalR adapter, Dashboard, Security

### Constraints
- Do not persist tokens to disk in plaintext
- Token lifetime is short — must support refresh

---

## TSD

### Overview
`topstep_auth` module provides two modes:
- `extractFromWebContents(webContents)` — execute JS in left pane to read localStorage/sessionStorage
- `rpaRefresh(env)` — optional Puppeteer flow (used by workers) to programmatically login and extract tokens for headless environments

### Interfaces
- `startMonitor(webContents)` — monitors and emits `token-ready` events
- `forceRefresh()` — triggers RPA refresh (if configured)
- `on('token-ready', (token)=>{})`
- `getToken()` — returns cached token (masked in logs)

### Security
- Token stored only in memory, masked in logs
- Optionally store encrypted token in OS keychain if persistent sessions required

### Tests
- Unit: simulate DOM with token in localStorage
- Integration: with Electron left-pane to ensure extraction flow
- RPA: headless Puppeteer script executed in worker environment (separate tests)

### Effort Estimate
1–2 dev days
