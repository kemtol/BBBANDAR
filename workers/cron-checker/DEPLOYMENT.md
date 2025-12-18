# Cron Checker - Deployment Guide

## Prerequisites

You need to create a KV namespace for storing worker execution state.

## Step 1: Create KV Namespace

```bash
cd /home/mkemalw/Projects/BBBANDAR/workers
wrangler kv namespace create CRON_STATE
```

This will output something like:
```
✨ Success!
Add the following to your wrangler.toml:
{ binding = "CRON_STATE", id = "abc123xyz456..." }
```

**Copy the KV namespace ID** - you'll need it for all three workers.

## Step 2: Update wrangler.toml Files

Since `wrangler.toml` files are gitignored, you need to manually update them:

### cron-checker/wrangler.toml

Add cron trigger and KV binding:

```toml
name = "cron-checker"
main = "src/index.js"
compatibility_date = "2024-11-01"

[triggers]
crons = ["* * * * *"]  # Every minute

[[kv_namespaces]]
binding = "CRON_STATE"
id = "YOUR_KV_ID_HERE"  # Replace with actual ID from Step 1
```

### fut-fetchers/wrangler.toml

**REMOVE** the existing `[triggers]` section and **ADD** KV binding:

```toml
# REMOVE THIS:
# [triggers]
# crons = ["0 * * * *"]

# ADD THIS:
[[kv_namespaces]]
binding = "CRON_STATE"
id = "YOUR_KV_ID_HERE"  # Same ID from Step 1
```

### fut-features/wrangler.toml

**REMOVE** the existing `[triggers]` section and **ADD** KV binding:

```toml
# REMOVE THIS:
# [triggers]
# crons = ["15 * * * *"]

# ADD THIS:
[[kv_namespaces]]
binding = "CRON_STATE"
id = "YOUR_KV_ID_HERE"  # Same ID from Step 1
```

## Step 3: Deploy Workers

Deploy in this order:

```bash
cd /home/mkemalw/Projects/BBBANDAR/workers

# Deploy fut-fetchers first
cd fut-fetchers
wrangler deploy
cd ..

# Deploy fut-features
cd fut-features
wrangler deploy
cd ..

# Deploy cron-checker last
cd cron-checker
wrangler deploy
cd ..
```

## Step 4: Verify Deployment

### Test /schedule endpoints

```bash
# Check fut-fetchers schedule
curl https://fut-fetchers.mkemalw.workers.dev/schedule

# Check fut-features schedule
curl https://fut-features.mkemalw.workers.dev/schedule
```

Expected output:
```json
{
  "ok": true,
  "worker": "fut-fetchers",
  "schedule": {
    "interval": "15m",
    "cron_expression": "*/15 * * * *"
  },
  "last_trigger": null,
  "next_trigger": null,
  "status": "unknown",
  "trigger_count": 0
}
```

### Check cron-checker health

```bash
curl https://cron-checker.mkemalw.workers.dev/health
```

Expected output:
```json
{
  "ok": true,
  "service": "cron-checker",
  "timestamp": "2025-12-17T...",
  "workers": [
    {
      "name": "fut-fetchers",
      "url": "https://fut-fetchers.mkemalw.workers.dev",
      "enabled": true,
      "schedule": "900s",
      "last_trigger": null,
      "next_trigger": null,
      "status": "unknown",
      "last_error": null,
      "trigger_count": 0
    },
    {
      "name": "fut-features",
      "url": "https://fut-features.mkemalw.workers.dev",
      "enabled": true,
      "schedule": "900s",
      "last_trigger": null,
      "next_trigger": null,
      "status": "unknown",
      "last_error": null,
      "trigger_count": 0
    }
  ]
}
```

### Test manual trigger

```bash
# Manually trigger all workers
curl -X POST https://cron-checker.mkemalw.workers.dev/trigger

# Check updated status
curl https://cron-checker.mkemalw.workers.dev/health
```

After manual trigger, you should see `last_trigger` timestamps updated.

## Step 5: Monitor Automatic Execution

Wait 1-2 minutes and check the health endpoint again:

```bash
curl https://cron-checker.mkemalw.workers.dev/health
```

You should see:
- `last_trigger` timestamps from the cron execution
- `next_trigger` timestamps 15 minutes in the future
- `status: "success"` if workers executed successfully
- `trigger_count` incrementing

## Step 6: Check KV State (Optional)

```bash
# View stored state
wrangler kv key get --namespace-id=YOUR_KV_ID fut-fetchers
wrangler kv key get --namespace-id=YOUR_KV_ID fut-features
```

## Troubleshooting

### Workers not triggering

1. Check cron-checker logs:
   ```bash
   wrangler tail cron-checker
   ```

2. Verify cron trigger is set in Cloudflare dashboard:
   - Go to Workers & Pages
   - Select `cron-checker`
   - Check Triggers tab

### KV errors

- Ensure all three workers have the **same** KV namespace ID
- Verify KV namespace exists: `wrangler kv namespace list`

### Schedule not updating

- Check that workers have CRON_STATE binding in wrangler.toml
- Verify workers can write to KV (check deployment logs)

## Success Criteria

✅ Only `cron-checker` has a cron trigger in Cloudflare dashboard  
✅ `fut-fetchers` and `fut-features` have no cron triggers  
✅ `/health` endpoint shows both workers with recent timestamps  
✅ Workers execute every 15 minutes automatically  
✅ KV state updates after each execution  

---

**Cron quota savings**: From 2 cron jobs → 1 cron job (50% reduction for pilot)
