
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

// ==============================
// WORKER STATUS & INTEGRITY CHECK
// ==============================
export async function getWorkerStatus(env) {
    const result = {
        workers: [], // Array of status objects
        data_integrity: {
            status: "UNKNOWN",
            last_file: null,
            last_file_age_ms: -1,
            bucket: "tape-data-saham",
            path_checked: ""
        },
        ts: Date.now()
    };

    // Helper: Check single worker
    const checkService = async (binding, name, label) => {
        const item = { name, label, status: "UNKNOWN", latency_ms: -1, details: null };
        if (!binding) {
            item.status = "MISSING";
            item.details = "Service binding not found";
            return item;
        }
        const start = Date.now();
        try {
            // Timeout 2s agar dashboard tidak lemot kalau worker mati
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);

            // Try fetch root "/"
            const res = await binding.fetch("https://internal/", { signal: controller.signal });
            clearTimeout(timeout);

            item.latency_ms = Date.now() - start;
            if (res.ok) {
                // Try parse JSON, fallback to text/status
                try {
                    const data = await res.json();
                    item.details = data;
                    // Logic health check standar
                    if (data.status && String(data.status).toUpperCase().includes("CONNECTED")) {
                        item.status = "HEALTHY";
                    } else if (data.status === "OK") {
                        item.status = "HEALTHY";
                    } else {
                        item.status = "WARNING"; // Online but status weird
                    }
                } catch (e) {
                    item.status = "ONLINE"; // Responded but not JSON
                    item.details = "OK (Non-JSON)";
                }
            } else {
                item.status = "ERROR";
                item.details = `HTTP ${res.status}`;
            }
        } catch (err) {
            item.status = "UNREACHABLE";
            item.details = String(err.message || err);
        }
        return item;
    };

    // Parallel checks
    const services = [
        // STOCKS
        { b: env.TAPING, n: 'livetrade-taping', l: 'Stock Taping' },
        { b: env.AGGREGATOR, n: 'livetrade-taping-agregator', l: 'Stock Aggregator' },
        { b: env.LT_STATE, n: 'livetrade-state-engine', l: 'Stock Engine' },
        // FUTURES
        { b: env.FUT_TAPING, n: 'fut-taping', l: 'Future Taping' },
        { b: env.FUT_AGGREGATOR, n: 'fut-taping-agregator', l: 'Future Aggregator' },
        { b: env.FUT_FEATURES, n: 'fut-features', l: 'Future Features' },
    ];

    result.workers = await Promise.all(services.map(s => checkService(s.b, s.n, s.l)));

    // 2. Cek Data Integrity (R2) - Existing Logic
    if (env.DATA_LAKE) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const pathPrefix = `raw_lt/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${pad(now.getHours())}/`;

        result.data_integrity.path_checked = pathPrefix;

        try {
            let objects = await env.DATA_LAKE.list({ prefix: pathPrefix });
            if (objects.objects.length === 0 && now.getMinutes() < 5) {
                const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
                const prevPath = `raw_lt/${oneHourAgo.getFullYear()}/${pad(oneHourAgo.getMonth() + 1)}/${pad(oneHourAgo.getDate())}/${pad(oneHourAgo.getHours())}/`;
                const objPrev = await env.DATA_LAKE.list({ prefix: prevPath });
                if (objPrev.objects.length > 0) objects = objPrev;
            }

            if (objects.objects.length > 0) {
                const lastObj = objects.objects[objects.objects.length - 1];
                result.data_integrity.last_file = lastObj.key;

                // Try parse timestamp from filename
                const parts = lastObj.key.split('/');
                const ts = Number(parts[parts.length - 1].replace('.json', ''));

                if (!isNaN(ts)) {
                    result.data_integrity.last_file_age_ms = Date.now() - ts;
                    if (result.data_integrity.last_file_age_ms < 120000) result.data_integrity.status = "OK";
                    else if (result.data_integrity.last_file_age_ms < 300000) result.data_integrity.status = "LAGGING";
                    else result.data_integrity.status = "STALE";
                } else {
                    result.data_integrity.last_file_age_ms = Date.now() - new Date(lastObj.uploaded).getTime();
                    result.data_integrity.status = "OK";
                }
            } else {
                result.data_integrity.status = "EMPTY";
            }
        } catch (err) {
            result.data_integrity.status = "ERROR";
            result.data_integrity.error = String(err);
        }
    }

    return withCORS(
        new Response(
            JSON.stringify(result, null, 2),
            { headers: { "Content-Type": "application/json" } }
        )
    );
}
