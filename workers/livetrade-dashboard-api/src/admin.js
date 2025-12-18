
// workers/livetrade-dashboard-api/src/admin.js

// Duplicated helper for standalone handling
function withCORS(resp) {
    const headers = new Headers(resp.headers || {});
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "*");

    return new Response(resp.body, {
        status: resp.status || 200,
        headers,
    });
}

// Helper to check R2
async function checkR2(bucket, prefix) {
    if (!bucket) return { status: "ERROR", detail: "No Binding" };
    try {
        const list = await bucket.list({ prefix, limit: 1 });
        if (list.objects.length > 0) {
            const latest = list.objects[0]; // Just taking the first one found
            const ageMs = Date.now() - latest.uploaded.getTime();
            return {
                status: "OK",
                detail: `${list.objects.length} files`,
                last_file: latest.key,
                age_ms: ageMs
            };
        }
        return { status: "EMPTY", detail: "0 files" };
    } catch (e) {
        return { status: "ERROR", detail: String(e.message) };
    }
}

// ==============================
// WORKER STATUS & INTEGRITY CHECK
// ==============================
export async function getWorkerStatus(env) {
    const result = {
        workers: [], // Array of status objects
        r2_monitor: {
            stock: {},
            futures: {}
        },
        // Legacy fallback fields for safety
        worker: { name: "livetrade-taping (legacy)", status: "UNKNOWN" },
        data_integrity: { status: "UNKNOWN", bucket: "tape-data-saham" },
        ts: Date.now()
    };

    // --- 1. Worker Health Checks (Parallel) ---
    const checkService = async (binding, name, label) => {
        const item = { name, label, status: "UNKNOWN", latency_ms: -1, details: null };
        if (!binding) {
            item.status = "MISSING";
            item.details = "Binding missing in wrangler.jsonc";
            return item;
        }
        const start = Date.now();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const res = await binding.fetch("https://internal/", { signal: controller.signal });
            clearTimeout(timeout);

            item.latency_ms = Date.now() - start;
            if (res.ok) {
                item.status = "ONLINE";
                try {
                    const data = await res.json();
                    item.details = data;
                    const ds = (data.status || "").toUpperCase();
                    if (ds.includes("CONNECTED") || ds === "OK") item.status = "HEALTHY";
                    else item.status = "WARNING";
                } catch (e) {
                    item.details = "Non-JSON Response";
                }
            } else {
                item.status = "ERROR";
                item.details = `HTTP ${res.status}`;
            }
        } catch (err) {
            item.status = "UNREACHABLE";
            item.details = String(err.message);
        }
        return item;
    };

    const services = [
        { b: env.TAPING, n: 'livetrade-taping', l: 'Stock Taping' },
        { b: env.AGGREGATOR, n: 'livetrade-taping-agregator', l: 'Stock Aggregator' },
        { b: env.LT_STATE, n: 'livetrade-state-engine', l: 'Stock Engine' },
        { b: env.FUT_TAPING, n: 'fut-taping', l: 'Future Taping' },
        { b: env.FUT_AGGREGATOR, n: 'fut-taping-agregator', l: 'Future Aggregator' },
        { b: env.FUT_FEATURES, n: 'fut-features', l: 'Future Features' },
    ];

    result.workers = await Promise.all(services.map(s => checkService(s.b, s.n, s.l)));

    // --- 2. R2 Data Integrity Checks (Parallel) ---
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const y = now.getUTCFullYear();
    const m = pad(now.getUTCMonth() + 1);
    const d = pad(now.getUTCDate());
    const h = pad(now.getUTCHours());

    const datePath = `${y}/${m}/${d}/`;     // YYYY/MM/DD/
    const dateDash = `${y}-${m}-${d}`;      // YYYY-MM-DD
    const dateMonth = `${y}${m}`;           // YYYYMM

    const checks = [
        // STOCK (Bucket: DATA_LAKE)
        { g: 'stock', k: 'raw', b: env.DATA_LAKE, p: `raw_lt/${datePath}` },
        { g: 'stock', k: 'agg', b: env.DATA_LAKE, p: `raw_lt_compressed/${dateDash}` }, // partial match prefix
        { g: 'stock', k: 'features', b: env.DATA_LAKE, p: `features/` }, // Generic

        // FUTURES (Bucket: DATA_LAKE_FUTURES)
        { g: 'futures', k: 'raw', b: env.DATA_LAKE_FUTURES, p: `raw_tns/ENQ/${datePath}${h}` },
        { g: 'futures', k: 'agg', b: env.DATA_LAKE_FUTURES, p: `footprint/ENQ/1m/${datePath}${h}` },
        { g: 'futures', k: 'features', b: env.DATA_LAKE_FUTURES, p: `features/${dateMonth}` }
    ];

    const r2Promises = checks.map(async (c) => {
        const res = await checkR2(c.b, c.p);
        return { g: c.g, k: c.k, res };
    });

    const r2Results = await Promise.all(r2Promises);
    r2Results.forEach(r => {
        if (result.r2_monitor[r.g]) {
            result.r2_monitor[r.g][r.k] = r.res;
        }
    });

    // --- 3. Legacy Backward Compat ---
    // (Optional: maintain old structure if dashboard breaks, but we updated dashboard)
    if (result.r2_monitor.stock.raw) {
        const raw = result.r2_monitor.stock.raw;
        result.data_integrity.status = raw.status;
        result.data_integrity.last_file_age_ms = raw.age_ms;
    }

    return withCORS(
        new Response(
            JSON.stringify(result, null, 2),
            { headers: { "Content-Type": "application/json" } }
        )
    );
}
