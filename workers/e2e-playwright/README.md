# SSSAHAM Playwright E2E

Standalone Playwright workspace for the broker summary screener flow.

## Environment

- `APP_BASE_URL` defaults to `https://app-sssaham.mkemalw.workers.dev`
- `API_BASE_URL` defaults to `https://api-saham.mkemalw.workers.dev`

## Install

```bash
cd workers/e2e-playwright
npm install
npx playwright install chromium
```

## Run

```bash
npm test
```

Useful variants:

```bash
APP_BASE_URL=https://app-sssaham.mkemalw.workers.dev npm test
API_BASE_URL=https://api-saham.mkemalw.workers.dev npm test
npm run test:headed
```

## What it checks

- Screener page loads and renders rows.
- Initial screener request uses `include_orderflow=false`.
- Bulk orderflow hydration hits `/orderflow/snapshots`.
- The screener does not fan out into many per-symbol cache requests.
- Search filters rows by symbol.
- Clicking a row opens detail mode for that symbol.
