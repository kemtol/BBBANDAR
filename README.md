# BBBANDAR — Project Reference

## 📂 Directory Structure Overview

### 🖥️ Frontends

| Path | Description |
| :--- | :--- |
| `index.html` | **Main Landing Page**. Entry point for the ecosystem. |
| `admin-dashboard.html` | **Admin Dashboard**. Monitors worker health, cron jobs, and housecleaning status. |
| `performance-report.html` | **Performance Reports**. Visualizes portfolio/trading performance. |
| `runningtrade/` | **Stock Analysis App**. Contains module specific pages (Emiten, Intraday, Swing). |
| `futures/` | **Futures Trading Platform**. Full trading UI with Auth (Login/Reg) and Charts. |
| `about-us.html` | Company/Project info page. |
| `home.html` | Dashboard home (internal user). |
| `verification.html` | Account verification flow. |

---

### 🔌 API Services

#### 🌍 Public APIs (Client Facing)
These services are directly accessible by frontend applications (Vue/React/HTML).

| Worker | Endpoints | Auth | Description |
| :--- | :--- | :--- | :--- |
| **`auth-uid`** | `/register`, `/login`, `/me`, `/profile/update` | **JWT (Cookie)** | User identity, session management, and profile handling. |
| **`api-saham`** | `/health`, `/docs`, `/openapi.json` | **None** | Public documentation and health checks. |

#### 🔒 Private APIs (Protected/Internal)
These endpoints require `X-API-KEY` or are strictly for internal communication/cron.

| Worker | Endpoints | Auth | Description |
| :--- | :--- | :--- | :--- |
| **`api-saham`** | `/signal/{kode}`, `/summary`, `/market/roster` | **X-API-KEY** | Premium stock signals and market data. |
| **`livetrade-dashboard-api`** | `/job-monitoring`, `/worker-status` | **Internal** | Provides metrics for `admin-dashboard.html`. |
| **`cron-checker`** | `/trigger`, `/check` | **Internal** | Orchestrares hourly checks. |
| **`fut-taping-agregator`** | `/run-cron`, `/compress` | **Internal** | Housecleaning trigger (called by cron-checker). |

---

### ☁️ Cloudflare Workers

Workers are located in `workers/`.

#### 📈 Stock Data Pipeline
| Worker Name | Path | Description |
| :--- | :--- | :--- |
| `livetrade-taping` | `workers/livetrade-taping` | **Ingestion**. Connects to socket, buffers stock trade data. |
| `livetrade-taping-agregator` | `workers/livetrade-taping-agregator` | **Aggregation & Cleanup**. Aggregates raw trades -> OHLCV. Handles daily housecleaning. |
| `livetrade-state-engine` | `workers/livetrade-state-engine` | **State Management**. Durable Object for consistent state. |
| `api-saham` | `workers/api-saham` | **Public API**. Serves stock data to frontends. |
| `livetrade-dashboard-api` | `workers/livetrade-dashboard-api` | **Dashboard Backend**. API for admin monitoring. |

#### 💸 Futures Data Pipeline
| Worker Name | Path | Description |
| :--- | :--- | :--- |
| `fut-taping` | `workers/fut-taping` | **Ingestion Proxy**. Forwards WebSocket data to state engine. |
| `fut-state-engine` | `workers/fut-state-engine` | **Core Logical Engine**. DO for Futures taping.Stores raw data (`raw_tns`). |
| `fut-taping-agregator` | `workers/fut-taping-agregator` | **Aggregation & Housecleaning**. Processes raw -> Footprint JSON. Handles **Compression/Pruning**. |
| `fut-fetchers` | `workers/fut-fetchers` | **Data Fetching**. Pulls external data (FRED, FINRA). |
| `fut-features` | `workers/fut-features` | **Feature Engineering**. Calculates signals/indicators. |

#### 🛠️ Utility & Infrastructure
| Worker Name | Path | Description |
| :--- | :--- | :--- |
| `cron-checker` | `workers/cron-checker` | **Cron Orchestrator**. Centralized trigger for other workers (hourly/minutely). |
| `batch-delete` | `workers/batch-delete` | **Maintenance**. Helper for bulk R2 deletions. |
| `auth-uid` | `workers/auth-uid` | **Authentication**. Manages user IDs and sessions. |
| `asset-router` | `workers/asset-router` | Asset routing and serving. |
| `asset-analyzer` | `workers/asset-analyzer` | Deep analysis of asset data. |
| `asset-preprocess` | `workers/asset-preprocess` | Pre-processing pipeline for assets. |
| `multi-agent` | `workers/multi-agent` | Experimental multi-agent system. |

---

## 🔄 Key Workflows

### 1. Futures Housecleaning (Run Hourly)
*   **Worker**: `fut-taping-agregator`
*   **Trigger**: Hourly via `cron-checker` (`/run-cron`).
*   **Process**:
    1.  **Safety Check**: Aborts if "Today's" data is missing.
    2.  **Compress**: Aggregates `raw_tns/{SYMBOL}/{DATE}` -> `raw_tns_compressed/{SYMBOL}/{DATE}.jsonl.gz`.
    3.  **Verify**: Decompresses & checks integrity (Signature match).
    4.  **Sanity Report**: Writes `raw_tns_compressed/sanity-info.json` to R2 (used by Dashboard).
    5.  **Prune**: Deletes raw files **ONLY** if compressed version is verified.

### 2. Stock Data Flow
*   `livetrade-taping` captures WebSocket stream.
*   Data buffered to R2 (`raw_lt`).
*   `livetrade-taping-agregator` runs daily to compress & clean.

## 📦 Deployment Guides

### Deploy Single Worker
To deploy a specific worker:
```bash
cd workers/<worker-name>
npx wrangler deploy
```

### Script Helpers
*   `scripts/pull-worker.sh`: Fetch deployed worker script.
*   `run-workers.sh`: Run workers locally (simulated).
