# Cron Checker

Centralized cron orchestrator for Cloudflare Workers - reduces cron quota usage by managing multiple workers from a single cron trigger.

## Architecture

```
┌─────────────┐
│ Cloudflare  │
│ Cron Trigger│ (every minute)
└──────┬──────┘
       │
       v
┌─────────────┐
│ cron-checker│
└──────┬──────┘
       │
       ├──────> fut-fetchers (every 15min)
       │
       └──────> fut-features (every 15min)
```

**Savings**: 2 cron jobs → 1 cron job (50% reduction for pilot)

## Features

- ✅ **Centralized scheduling**: Single cron job manages multiple workers
- ✅ **Flexible intervals**: Each worker has its own schedule
- ✅ **State persistence**: KV storage tracks execution history
- ✅ **Health monitoring**: `/health` endpoint shows all worker statuses
- ✅ **Manual triggering**: Test workers without waiting for cron

## API Endpoints

### GET /health

Returns status of all registered workers.

**Response**:
```json
{
  "ok": true,
  "service": "cron-checker",
  "timestamp": "2025-12-17T08:30:00Z",
  "workers": [
    {
      "name": "fut-fetchers",
      "url": "https://fut-fetchers.mkemalw.workers.dev",
      "enabled": true,
      "schedule": "900s",
      "last_trigger": "2025-12-17T08:15:00Z",
      "next_trigger": "2025-12-17T08:30:00Z",
      "status": "success",
      "last_error": null,
      "trigger_count": 42
    }
  ]
}
```

### POST /trigger

Manually trigger all workers (testing).

**Response**:
```json
{
  "ok": true,
  "manual_trigger": true,
  "timestamp": "2025-12-17T08:30:00Z",
  "results": [
    {
      "worker": "fut-fetchers",
      "ok": true,
      "status": 200,
      "timestamp": "2025-12-17T08:30:00Z",
      "response": { ... }
    }
  ]
}
```

### POST /check

Manually run cron check logic (testing).

## Configuration

### Worker Registry

Edit `src/index.js` to add/remove workers:

```javascript
const WORKERS = [
  {
    name: 'fut-fetchers',
    url: 'https://fut-fetchers.mkemalw.workers.dev',
    endpoint: '/run',
    schedule: {
      interval: 900, // seconds
      unit: 'seconds'
    },
    enabled: true
  }
];
```

### Schedule Format

- `interval`: Number of seconds between executions
- Common intervals:
  - Every minute: `60`
  - Every 5 minutes: `300`
  - Every 15 minutes: `900`
  - Every hour: `3600`
  - Every day: `86400`

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed setup instructions.

Quick start:
1. Create KV namespace: `wrangler kv namespace create CRON_STATE`
2. Update `wrangler.toml` with KV ID
3. Deploy: `wrangler deploy`

## Requirements

Workers managed by cron-checker must:
- Have a `POST /run` endpoint that executes the worker's main task
- Optionally have a `GET /schedule` endpoint that returns schedule metadata
- Be accessible from cron-checker (no authentication required, or use service bindings)

## Monitoring

### Check execution logs

```bash
wrangler tail cron-checker
```

### View KV state

```bash
wrangler kv key get --namespace-id=YOUR_KV_ID worker-name
```

### Cloudflare Dashboard

- Workers & Pages → cron-checker → Metrics
- Check invocation counts and errors

## Troubleshooting

**Workers not triggering**:
- Check cron trigger is configured in Cloudflare dashboard
- Verify worker URLs are correct in registry
- Check worker `/run` endpoints are accessible

**KV errors**:
- Ensure CRON_STATE binding is configured
- Verify KV namespace exists and ID is correct
- Check KV permissions

**Status shows "failed"**:
- Check worker logs: `wrangler tail worker-name`
- Verify worker `/run` endpoint returns 200 OK
- Check for worker-specific errors

## Expanding the System

To add more workers to the orchestrator:

1. Add worker to registry in `src/index.js`
2. Ensure worker has `/run` endpoint
3. Optionally add `/schedule` endpoint for metadata
4. Deploy cron-checker: `wrangler deploy`

No need to change Cloudflare cron triggers!
