# Centralized Cron Checker - Configuration Guide

## Quick Setup

Copy the example files to actual wrangler.toml:

```bash
cd /home/mkemalw/Projects/BBBANDAR/workers

# Copy configuration files
cp cron-checker/wrangler.toml.example cron-checker/wrangler.toml
cp fut-fetchers/wrangler.toml.example fut-fetchers/wrangler.toml
cp fut-features/wrangler.toml.example fut-features/wrangler.toml
```

## Deploy Workers

```bash
# Deploy in order
cd cron-checker && wrangler deploy && cd ..
cd fut-fetchers && wrangler deploy && cd ..
cd fut-features && wrangler deploy && cd ..
```

## Verify Deployment

### 1. Check worker endpoints
```bash
# Test schedule endpoints
curl https://fut-fetchers.mkemalw.workers.dev/schedule
curl https://fut-features.mkemalw.workers.dev/schedule

# Test cron-checker health
curl https://cron-checker.mkemalw.workers.dev/health
```

### 2. Manual trigger test
```bash
# Trigger all workers manually
curl -X POST https://cron-checker.mkemalw.workers.dev/trigger

# Check health again to see updated state
curl https://cron-checker.mkemalw.workers.dev/health
```

### 3. Wait for automatic execution
```bash
# Wait 15 minutes, then check
curl https://cron-checker.mkemalw.workers.dev/health
```

You should see:
- `last_trigger` timestamps updated
- `next_trigger` 15 minutes in the future
- `status: "success"`
- `trigger_count` incrementing

## Important Notes

### KV Namespace
- All three workers share the same KV namespace: `5a7ef6911df742faae88edd35228aeb5`
- This namespace stores execution state for tracking

### Cron Triggers
- **Only cron-checker** should have a cron trigger (`* * * * *`)
- **fut-fetchers** and **fut-features** should NOT have cron triggers
- If you see cron triggers on fut-fetchers/fut-features in Cloudflare dashboard, remove them manually

### Environment Variables
For `fut-fetchers`, if FRED_API_KEY is not already set as a secret:
```bash
cd /home/mkemalw/Projects/BBBANDAR/workers/fut-fetchers
wrangler secret put FRED_API_KEY
# Enter your FRED API key when prompted
```

## Troubleshooting

If manual trigger returns 404 errors:
1. Verify workers are deployed
2. Check `/run` endpoints work directly:
   ```bash
   curl -X POST https://fut-fetchers.mkemalw.workers.dev/run
   curl -X POST https://fut-features.mkemalw.workers.dev/run
   ```
3. Redeploy cron-checker with KV binding
4. Check Cloudflare dashboard for deployment errors

## Success Criteria

✅ `cron-checker` has cron trigger in dashboard  
✅ `fut-fetchers` and `fut-features` have NO cron triggers  
✅ All workers have CRON_STATE KV binding  
✅ `/health` endpoint shows worker status  
✅ Manual trigger succeeds (no 404 errors)  
✅ Workers execute every 15 minutes automatically  
