
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
        worker: {
            name: "livetrade-taping",
            status: "UNKNOWN",
            details: null,
            latency_ms: -1
        },
        data_integrity: {
            status: "UNKNOWN",
            last_file: null,
            last_file_age_ms: -1,
            bucket: "tape-data-saham",
            path_checked: ""
        },
        ts: Date.now()
    };

    // 1. Cek Worker Status via Service Binding
    if (env.TAPING) {
        const start = Date.now();
        try {
            // Panggil endpoint root / dari livetrade-taping
            const res = await env.TAPING.fetch("https://internal/");
            const latency = Date.now() - start;

            if (res.ok) {
                const data = await res.json();
                result.worker.status = "ONLINE"; // Worker responds
                result.worker.details = data;
                result.worker.latency_ms = latency;

                // Cek status internal worker
                // data.status biasanya "CONNECTED (LT + OB watchlist)" atau "Mati"
                if (data.status && data.status.startsWith("CONNECTED")) {
                    result.worker.status = "HEALTHY";
                } else {
                    result.worker.status = "WARNING"; // Responding but not connected
                }

            } else {
                result.worker.status = "ERROR";
                result.worker.details = `HTTP ${res.status}`;
            }
        } catch (err) {
            result.worker.status = "UNREACHABLE";
            result.worker.details = String(err);
        }
    } else {
        result.worker.details = "Binding TAPING missing";
    }

    // 2. Cek Data Integrity (R2)
    if (env.DATA_LAKE) {
        const now = new Date();
        // Cek path jam ini: raw_lt/YYYY/MM/DD/HH
        // Format: raw_lt/2025/08/08/10
        const pad = (n) => String(n).padStart(2, '0');
        const pathPrefix = `raw_lt/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${pad(now.getHours())}/`;

        result.data_integrity.path_checked = pathPrefix;

        try {
            // List files logic
            let objects = await env.DATA_LAKE.list({ prefix: pathPrefix });

            // Jika jam baru mulai (misal menit 00:01), mungkin folder jam ini masih kosong.
            // Cek jam sebelumnya jika kosong
            if (objects.objects.length === 0 && now.getMinutes() < 5) {
                const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
                const prevPath = `raw_lt/${oneHourAgo.getFullYear()}/${pad(oneHourAgo.getMonth() + 1)}/${pad(oneHourAgo.getDate())}/${pad(oneHourAgo.getHours())}/`;
                result.data_integrity.path_checked += ` OR ${prevPath}`;
                const objPrev = await env.DATA_LAKE.list({ prefix: prevPath });
                if (objPrev.objects.length > 0) objects = objPrev;
            }

            if (objects.objects.length > 0) {
                // Ambil yang terakhir di list (asumsi sorted by key ascending)
                const lastObj = objects.objects[objects.objects.length - 1];
                result.data_integrity.last_file = lastObj.key;

                // Coba parse timestamp dari nama file jika format: .../1723456789000.json
                const parts = lastObj.key.split('/');
                const fname = parts[parts.length - 1];
                const tsString = fname.replace('.json', '');
                const ts = Number(tsString);

                if (!isNaN(ts)) {
                    result.data_integrity.last_file_age_ms = Date.now() - ts;
                    // Status OK jika < 2 menit (120000ms) - asumsi data masuk setidaknya tiap menit
                    if (result.data_integrity.last_file_age_ms < 120000) {
                        result.data_integrity.status = "OK";
                    } else if (result.data_integrity.last_file_age_ms < 300000) {
                        result.data_integrity.status = "LAGGING"; // 2-5 mins delay
                    } else {
                        result.data_integrity.status = "STALE"; // > 5 mins
                    }
                } else {
                    // Fallback pakai uploaded property
                    const uploaded = lastObj.uploaded;
                    const age = Date.now() - new Date(uploaded).getTime();
                    result.data_integrity.last_file_age_ms = age;
                    result.data_integrity.status = age < 120000 ? "OK" : "STALE";
                }
            } else {
                result.data_integrity.status = "EMPTY"; // No data in current hour
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
