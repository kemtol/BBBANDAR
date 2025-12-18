# KV I/O Cost Analysis

## Current Usage Pattern

### Cron-Checker Executions
- **Frequency**: Every minute (1,440x/day)
- **Workers Managed**: 2 (fut-fetchers, fut-features)

### KV Operations Per Execution

**Every Minute (Check Phase)**:
- Read state for fut-fetchers: 1 read
- Read state for fut-features: 1 read
- **Subtotal**: 2 reads/minute

**Only When Triggering (Every 15 minutes)**:
- Write state for fut-fetchers: 1 write
- Write state for fut-features: 1 write
- **Subtotal**: 2 writes per trigger

## Daily Calculations

### Reads
```
1,440 minutes/day × 2 reads = 2,880 reads/day
```

### Writes
```
Workers trigger every 15 min = 96 triggers/day
96 triggers × 2 workers = 192 writes/day
```

### Total Daily Operations
- **Reads**: 2,880
- **Writes**: 192
- **Total**: 3,072 operations/day

## Cloudflare KV Free Tier Limits

- ✅ **Reads**: 100,000/day (using 2.9%)
- ✅ **Writes**: 1,000/day (using 19.2%)

## Verdict: ✅ TIDAK BOROS

Current usage **sangat aman** - hanya pakai:
- 2.9% of read quota
- 19.2% of write quota

## Alternative: Optimization for Scale

Jika nanti ada banyak workers (misalnya 10+), bisa optimize dengan:

### Option 1: In-Memory Cache
```javascript
// Cache state with 30s TTL
let stateCache = {};
let cacheExpiry = {};

async function getWorkerState(env, workerName) {
  const now = Date.now();
  if (stateCache[workerName] && cacheExpiry[workerName] > now) {
    return stateCache[workerName]; // Use cache
  }
  
  // Cache miss - fetch from KV
  const state = await env.CRON_STATE.get(workerName);
  stateCache[workerName] = JSON.parse(state);
  cacheExpiry[workerName] = now + 30000; // 30s TTL
  
  return stateCache[workerName];
}
```

**Savings**: ~50% read reduction (30s cache vs 60s cycle)

### Option 2: Batch KV Operations
```javascript
// Read all worker states in one operation
const allStates = await env.CRON_STATE.list();
// Parse and check
```

### Option 3: Conditional Read
```javascript
// Only read KV if near trigger time
const estimatedNextTrigger = lastKnownTrigger + interval;
if (now >= estimatedNextTrigger - 60000) {
  // Only read KV in last minute before trigger
  state = await getWorkerState(env, workerName);
}
```

**Savings**: ~93% read reduction (only 1 read per 15 min vs 15 reads)

## Recommendation

**For Current Scale (2 workers)**: 
- ✅ **Keep as-is** - usage is minimal
- No optimization needed
- Clean, simple code

**Future Scale (10+ workers)**:
- Consider Option 3 (Conditional Read)
- Keeps code simple
- Dramatic reduction in KV reads

## Cost Comparison

### Current (2 workers, every 1 min)
- Reads: 2,880/day (FREE)
- Writes: 192/day (FREE)
- **Cost**: $0/month

### Optimized (Option 3, conditional)
- Reads: ~200/day (FREE)
- Writes: 192/day (FREE)
- **Cost**: $0/month

### Future Scale (20 workers, unoptimized)
- Reads: 28,800/day (FREE)
- Writes: 1,920/day (PAID: 920 × $0.50/million = $0.00046/day)
- **Cost**: ~$0.01/month

**Conclusion**: Even at 10x scale, cost is negligible!
