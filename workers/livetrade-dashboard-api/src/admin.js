
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
// ==============================
// SANITY CHECK (JOB MONITORING)
// ==============================
export async function generateSanityCheck(env) {
    const now = new Date();
    // Use WIB (UTC+7) for logic as requested (market open 09:00)
    // Actually best to keep it UTC internally but the user described "09:00" which is likely WIB.
    // Let's assume user input (09:00 - 16:00) is WIB.
    const hWib = (now.getUTCHours() + 7) % 24;
    const pad = (n) => String(n).padStart(2, '0');

    const y = now.getUTCFullYear();
    const m = pad(now.getUTCMonth() + 1);
    const d = pad(now.getUTCDate());
    const dateStr = `${y}-${m}-${d}`;

    const jobs = {
        fetch_1m: { name: "Fetch 1m", times: [9, 10, 11, 14, 15] }, // WIB hours roughly
        agg_service: { name: "Aggregation Service", times: [9, 10, 11, 14, 15] },
        r2_housekeeping: { name: "R2 Housekeeping", times: [16] },
        core_bpjs: { name: "core-bpjs", times: [9, 12, 16] },
        rekomendasi: { name: "Rekomendasi", times: [9, 16] },
        kv_sync: { name: "Sync KV", times: [8, 12, 18] }
    };

    const statusMap = {
        fetch_1m: {},
        agg_service: {},
        r2_housekeeping: {},
        core_bpjs: {},
        rekomendasi: {},
        kv_sync: {}
    };

    // --- LOGIC: FETCH 1M ---
    // Rule:
    // If inside market hours (09:00 - 16:00 WIB), check if file exists for current hour.
    // If outside, check if last file is 16:00.

    // We need to iterate over the "Times" columns in the dashboard (09:30, 10:30, etc)
    // The dashboard columns are fixed: ["09:30", "10:30", "11:30", "14:15", "15:50", "23:59"]
    // Let's map these to hour prefixes for checking.

    // Simplification: We will key the result by time label, e.g. "09:30".
    // For each label, we check if data exists.

    // --- DYNAMIC SLOTS: LAST 6 HOURS ---
    const slots = [];
    const currentWibH = (now.getUTCHours() + 7) % 24;

    // Generate last 6 hours (e.g. if 18, then 13,14,15,16,17,18)
    for (let i = 5; i >= 0; i--) {
        let h = currentWibH - i;
        if (h < 0) h += 24; // Handle day wrap
        slots.push(h);
    }

    const padH = (n) => String(n).padStart(2, '0') + ":00";

    // Helper to check R2 for sanity file
    const checkFile = async (bucket, path) => {
        const obj = await bucket.get(path);
        if (!obj) return "FAIL";
        try {
            const data = await obj.json();
            if (data.status === "OK") return "OK";
            return "FAIL";
        } catch {
            return "FAIL";
        }
    };

    // 1. Fetch 1m (Raw Stock) -> raw_lt/YYYY/MM/DD/HH/sanity-info.json
    const fetch1mStatus = {};
    for (const h of slots) {
        const label = padH(h);

        // Rule: check 16 if > 16.
        let targetH = h;
        if (h > 16) targetH = 16;
        if (h < 9) { fetch1mStatus[label] = "PENDING"; continue; }

        // Convert to UTC for path
        let utcH = targetH - 7;
        if (utcH < 0) utcH += 24;

        const path = `raw_lt/${y}/${m}/${d}/${String(utcH).padStart(2, '0')}/sanity-info.json`;
        fetch1mStatus[label] = await checkFile(env.DATA_LAKE, path);
    }
    statusMap.fetch_1m = fetch1mStatus;

    // 2. Aggregation Service (Daily Job) -> backfill_state_YYYY-MM-DD.json
    // Logic: If state exists: done=true -> OK, done=false -> RUN. Else -> PENDING.
    const aggStatePath = `backfill_state_${dateStr}.json`;
    const aggStateObj = await env.DATA_LAKE.get(aggStatePath);
    let aggStatus = "PENDING";

    if (aggStateObj) {
        try {
            const state = await aggStateObj.json();
            if (state.done) aggStatus = "OK";
            else aggStatus = "RUN";
        } catch {
            aggStatus = "FAIL"; // Corrupt state file
        }
    } else {
        // Fallback: Check if final processed file exists (maybe state was deleted)
        const finalPath = `processed/${dateStr}.json`;
        const finalObj = await env.DATA_LAKE.head(finalPath);
        if (finalObj) aggStatus = "OK";
    }

    // Apply to all slots for agg_service (Daily status applies to all hours)
    statusMap.agg_service = {};
    slots.forEach(h => statusMap.agg_service[padH(h)] = aggStatus);

    // Fill other jobs with placeholders
    for (const k in statusMap) {
        if (k === 'fetch_1m' || k === 'agg_service') continue;
        const s = {};
        slots.forEach(h => s[padH(h)] = "PENDING");
        statusMap[k] = s;
    }

    // --- LOGIC: FUTURES ---
    const futMap = {
        fut_fetch: {},
        fut_agg: {},
        fut_r2: {}
    };

    // 1. Fetch Service (fut_fetch) -> raw_tns/ENQ/YYYY/MM/DD/HH/sanity-info.json
    for (const h of slots) {
        const label = padH(h);

        // For futures we just check slot as is
        let utcH = h - 7;
        if (utcH < 0) utcH += 24;

        const path = `raw_tns/ENQ/${y}/${m}/${d}/${String(utcH).padStart(2, '0')}/sanity-info.json`;
        futMap.fut_fetch[label] = await checkFile(env.DATA_LAKE_FUTURES, path);
    }
    // 2. Aggregation Service (fut_agg) -> footprint/ENQ/1m/YYYY/MM/DD/HH_sanity.json
    for (const h of slots) {
        const label = padH(h);

        let utcH = h - 7;
        if (utcH < 0) utcH += 24;

        const path = `footprint/ENQ/1m/${y}/${m}/${d}/${String(utcH).padStart(2, '0')}_sanity.json`;
        futMap.fut_agg[label] = await checkFile(env.DATA_LAKE_FUTURES, path);
    }

    // 3. Housekeeping (fut_r2) -> Placeholder
    for (const h of slots) futMap.fut_r2[padH(h)] = "PENDING";

    // Construct Final Object
    const result = {
        date: dateStr,
        ts: Date.now(),
        stocks: statusMap,
        futures: futMap
    };

    // Write to R2
    await env.DATA_LAKE.put(`system/monitoring/${dateStr}.json`, JSON.stringify(result, null, 2));
    await env.DATA_LAKE.put(`system/monitoring_latest.json`, JSON.stringify(result, null, 2));

    return result;
}

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
