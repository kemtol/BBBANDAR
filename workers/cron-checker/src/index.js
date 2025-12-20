// cron-checker/src/index.js
// Centralized cron orchestrator - manages all worker scheduling

// Worker registry configuration
const WORKERS = [
    {
        name: 'fut-fetchers',
        binding: 'FUT_FETCHERS',  // Service binding name
        url: 'https://fut-fetchers.mkemalw.workers.dev',
        endpoint: '/run',
        schedule: {
            interval: 900, // 15 minutes in seconds
            unit: 'seconds'
        },
        enabled: true
    },
    {
        name: 'fut-features',
        binding: 'FUT_FEATURES',  // Service binding name
        url: 'https://fut-features.mkemalw.workers.dev',
        endpoint: '/run',
        schedule: {
            interval: 900, // 15 minutes in seconds
            unit: 'seconds'
        },
        enabled: true
    },
    {
        name: 'livetrade-taping-agregator',
        binding: 'LIVETRADE_AGG',  // Service binding name
        url: 'https://livetrade-taping-agregator.mkemalw.workers.dev',
        endpoint: '/run',
        schedule: {
            interval: 3600, // 1 hour in seconds
            unit: 'seconds'
        },
        enabled: true
    },
    {
        name: 'livetrade-taping',
        binding: null,  // Force HTTP fetch
        url: 'https://livetrade-taping.mkemalw.workers.dev',
        endpoint: '/status', // Keep-alive / Resurrection
        schedule: {
            interval: 60, // 1 minute in seconds
            unit: 'seconds'
        },
        enabled: true
    },
    {
        name: 'fut-footprint', // Minutely Aggregation
        binding: null,
        url: 'https://fut-taping-agregator.mkemalw.workers.dev',
        endpoint: '/run-cron?mode=aggregation',
        schedule: {
            interval: 60, // 1 minute
            unit: 'seconds'
        },
        enabled: true
    },
    {
        name: 'fut-housekeeping-daily', // Hourly/Daily Cleanup
        binding: null,
        url: 'https://fut-taping-agregator.mkemalw.workers.dev',
        endpoint: '/run-cron?mode=housekeeping',
        schedule: {
            interval: 3600, // 1 hour
            unit: 'seconds'
        },
        enabled: true
    }
];

// Calculate if worker should run based on schedule
function shouldTrigger(lastTriggerTime, intervalSeconds) {
    if (!lastTriggerTime) return true; // Never run before

    const now = Date.now();
    const lastTrigger = new Date(lastTriggerTime).getTime();
    const elapsed = (now - lastTrigger) / 1000; // seconds

    return elapsed >= intervalSeconds;
}

// Calculate next trigger time
function calculateNextTrigger(intervalSeconds) {
    return new Date(Date.now() + (intervalSeconds * 1000)).toISOString();
}

// Trigger a worker
async function triggerWorker(worker, env) {
    // Use service binding if available, otherwise fall back to HTTP
    const binding = env[worker.binding];

    try {
        let response;

        if (binding) {
            // Use service binding (internal worker-to-worker call)
            const request = new Request(`https://placeholder${worker.endpoint}`, {
                method: 'POST',
                headers: {
                    'X-Triggered-By': 'cron-checker'
                }
            });
            response = await binding.fetch(request);
        } else {
            // Fallback to HTTP fetch (external call)
            const url = `${worker.url}${worker.endpoint}`;
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'User-Agent': 'cron-checker/1.0',
                    'X-Triggered-By': 'cron-checker'
                }
            });
        }

        const result = {
            ok: response.ok,
            status: response.status,
            timestamp: new Date().toISOString(),
            method: binding ? 'service-binding' : 'http'
        };

        if (response.ok) {
            try {
                const data = await response.json();
                result.response = data;
            } catch (e) {
                result.response = await response.text();
            }
        } else {
            result.error = `HTTP ${response.status}`;
        }

        return result;
    } catch (error) {
        return {
            ok: false,
            error: error.message,
            timestamp: new Date().toISOString(),
            method: binding ? 'service-binding' : 'http'
        };
    }
}

// Get worker state from R2
async function getWorkerState(env, workerName) {
    if (!env.STATE_BUCKET) return null;

    try {
        const key = `cron-state/${workerName}.json`;
        const obj = await env.STATE_BUCKET.get(key);
        return obj ? await obj.json() : null;
    } catch (error) {
        console.error(`Failed to get state for ${workerName}:`, error);
        return null;
    }
}

// Update worker state in R2
async function updateWorkerState(env, workerName, state) {
    if (!env.STATE_BUCKET) return;

    try {
        const key = `cron-state/${workerName}.json`;
        await env.STATE_BUCKET.put(
            key,
            JSON.stringify(state, null, 2),
            { httpMetadata: { contentType: 'application/json' } }
        );
    } catch (error) {
        console.error(`Failed to update state for ${workerName}:`, error);
    }
}

// Main cron logic
async function runCronCheck(env) {
    const results = [];

    for (const worker of WORKERS) {
        if (!worker.enabled) {
            results.push({
                worker: worker.name,
                status: 'disabled',
                skipped: true
            });
            continue;
        }

        // Get current state
        const state = await getWorkerState(env, worker.name);
        const lastTrigger = state?.last_trigger || null;

        // Check if should trigger
        if (shouldTrigger(lastTrigger, worker.schedule.interval)) {
            console.log(`Triggering ${worker.name}...`);

            const triggerResult = await triggerWorker(worker, env);

            // Update state
            const newState = {
                last_trigger: triggerResult.timestamp,
                next_trigger: calculateNextTrigger(worker.schedule.interval),
                status: triggerResult.ok ? 'success' : 'failed',
                last_error: triggerResult.error || null,
                trigger_count: (state?.trigger_count || 0) + 1,
                last_response: triggerResult.response || null
            };

            await updateWorkerState(env, worker.name, newState);

            results.push({
                worker: worker.name,
                triggered: true,
                ...triggerResult
            });
        } else {
            const nextTrigger = state?.next_trigger || calculateNextTrigger(worker.schedule.interval);
            results.push({
                worker: worker.name,
                triggered: false,
                next_trigger: nextTrigger,
                last_trigger: lastTrigger
            });
        }
    }

    return {
        ok: true,
        timestamp: new Date().toISOString(),
        results
    };
}

// Get health status of all workers
async function getHealthStatus(env) {
    const statuses = [];

    for (const worker of WORKERS) {
        const state = await getWorkerState(env, worker.name);

        statuses.push({
            name: worker.name,
            url: worker.url,
            enabled: worker.enabled,
            schedule: `${worker.schedule.interval}s`,
            last_trigger: state?.last_trigger || null,
            next_trigger: state?.next_trigger || null,
            status: state?.status || 'unknown',
            last_error: state?.last_error || null,
            trigger_count: state?.trigger_count || 0
        });
    }

    return {
        ok: true,
        service: 'cron-checker',
        timestamp: new Date().toISOString(),
        workers: statuses
    };
}

// Manual trigger all workers
async function manualTriggerAll(env) {
    const results = [];

    for (const worker of WORKERS) {
        if (!worker.enabled) continue;

        const triggerResult = await triggerWorker(worker, env);

        const newState = {
            last_trigger: triggerResult.timestamp,
            next_trigger: calculateNextTrigger(worker.schedule.interval),
            status: triggerResult.ok ? 'success' : 'failed',
            last_error: triggerResult.error || null,
            trigger_count: ((await getWorkerState(env, worker.name))?.trigger_count || 0) + 1,
            last_response: triggerResult.response || null
        };

        await updateWorkerState(env, worker.name, newState);

        results.push({
            worker: worker.name,
            ...triggerResult
        });
    }

    return {
        ok: true,
        manual_trigger: true,
        timestamp: new Date().toISOString(),
        results
    };
}

// Export handlers
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Health status
        if (request.method === 'GET' && url.pathname === '/health') {
            return Response.json(await getHealthStatus(env));
        }

        // Manual trigger all
        if (request.method === 'POST' && url.pathname === '/trigger') {
            return Response.json(await manualTriggerAll(env));
        }

        // Manual cron check (testing)
        if (request.method === 'POST' && url.pathname === '/check') {
            return Response.json(await runCronCheck(env));
        }

        // Service info
        return Response.json({
            ok: true,
            service: 'cron-checker',
            version: '1.0.0',
            endpoints: [
                'GET /health - Worker status',
                'POST /trigger - Manual trigger all workers',
                'POST /check - Manual cron check (testing)'
            ],
            workers: WORKERS.map(w => ({
                name: w.name,
                enabled: w.enabled,
                schedule: `${w.schedule.interval}s`
            }))
        });
    },

    async scheduled(event, env, ctx) {
        // Run cron check
        ctx.waitUntil((async () => {
            try {
                const result = await runCronCheck(env);
                console.log('Cron check completed:', JSON.stringify(result, null, 2));
            } catch (error) {
                console.error('Cron check failed:', error);
            }
        })());
    }
};
