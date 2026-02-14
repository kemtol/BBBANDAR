# PRD & TSD — Dashboard UI and IPC

## PRD

### Objective
Operator interface to monitor live footprints, P&L, compliance status, order log and to control the agent (START/STOP/FLATTEN). Ensure secure IPC and prevent leaking tokens.

### Success Metrics
- UI updates within 200 ms of events
- Controls produce deterministic actions in main process

### Stakeholders
- Trader (operator), DevOps, QA

---

## TSD

### Architecture
- Electron BrowserViews: left pane (Topstep login/chart), right pane (dashboard)
- IPC channels (main ↔ renderer):
  - `live-trade` (emitted to renderer)
  - `candle` (candle closed)
  - `compliance-status` (periodic)
  - `agent-control` (renderer → main): {action: 'START'|'STOP'|'FLATTEN', strategy}
  - `fetch-features` (rpc-style)

### Data Flow
- Core modules emit events to `main.js` which forwards essential events to renderer (no tokens). Preload sanitizes any left-pane communications.

### UI Components
- Live footprint chart
- Order log (table)
- Compliance status panel (badges)
- Agent control buttons and strategy selector
- Position / P&L summary

### Testing
- Manual e2e: simulate events via dev mode
- Unit: renderer components (snapshot tests)

### Effort Estimate
3–5 dev days for skeleton + wiring
