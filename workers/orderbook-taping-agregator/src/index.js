// workers/orderbook-taping-agregator/src/index.js

// Worker ini tugasnya:
// - Baca raw_ob/... dari R2
// - Agregasi jadi ob_hist/{KODE}/{YYYY}/{MM}/{DD}.jsonl
// - (opsional) expose HTTP route buat debug / inspect
function computeIntentionFromOrderbookSnapshot(ob) {
    if (!ob) return 0;
    const bids = ob.bids || [];
    const offers = ob.offers || [];

    const bidVol = bids.reduce((acc, b) => acc + (b.volume || 0), 0);
    const offVol = offers.reduce((acc, o) => acc + (o.volume || 0), 0);

    const total = bidVol + offVol;
    if (!total) return 0;

    // (bid - offer) / total → -1..+1
    const raw = (bidVol - offVol) / total;
    return Math.max(-1, Math.min(1, raw));
}

// ========= ORDERBOOK HELPERS =========
// Parse payload JSON (INIT / UPDATE) jadi struktur ringkas
function parseOrderbookPayload(kode, tsMs, payload) {
    const ts = new Date(tsMs).toISOString();

    // 🔍 Kalau payload.raw adalah string JSON (INIT), buka dulu
    if (!payload.subcmd && typeof payload.raw === "string") {
        try {
            const inner = JSON.parse(payload.raw);
            if (inner && typeof inner === "object") {
                payload = inner; // sekarang punya subcmd, BUY, SELL, dll
            }
        } catch (e) {
            // kalau gagal, biarin lanjut ke branch recinfo / fallback
        }
    }

    const subcmd = payload.subcmd || "UNKNOWN";
    const result = {
        kode,
        ts,
        subcmd,
        best_bid: null,
        best_offer: null,
        bids: [],
        offers: [],
    };

    // KASUS 1: SNAPSHOT AWAL (INIT) — BUY & SELL berupa array [price, lot]
    if (subcmd === "INIT" && Array.isArray(payload.BUY) && Array.isArray(payload.SELL)) {
        const buys = payload.BUY;
        const sells = payload.SELL;

        // 3 level atas/bawah (sama seperti Python)
        const topBids = buys.slice(0, 3);
        const topOffers = sells.slice(0, 3);

        result.bids = topBids.map((b) => ({
            price: b[0],
            volume: b[1],
        }));

        result.offers = topOffers
            .slice()
            .reverse() // supaya paling tinggi di bawah (visual seperti print Python)
            .map((o) => ({
                price: o[0],
                volume: o[1],
            }));

        if (result.bids[0]) result.best_bid = result.bids[0];
        if (result.offers.length > 0) {
            // setelah reverse, best offer ada di index terakhir
            result.best_offer = result.offers[result.offers.length - 1];
        }

        return result;
    }

    // KASUS 2: UPDATE (string pipe di field recinfo)
    if (typeof payload.recinfo === "string") {
        const rawStr = payload.recinfo;

        if (!rawStr.includes("|;|")) {
            // format aneh, tapi tetap simpan
            result.raw = rawStr;
            return result;
        }

        const depthPart = rawStr.split("|;|")[1];
        const parts = depthPart.split("|");

        // parts[0] = best_bid, parts[1] = best_offer
        result.best_bid = { price: parts[0] || null, volume: null };
        result.best_offer = { price: parts[1] || null, volume: null };

        // Sisanya triplet: [price, bidVol, offerVol]
        const levels = [];
        for (let i = 3; i <= parts.length - 3; i += 3) {
            const p = parts[i];
            const bVolRaw = parts[i + 1];
            const oVolRaw = parts[i + 2];

            const bVol = bVolRaw ? parseInt(bVolRaw, 10) : 0;
            const oVol = oVolRaw ? parseInt(oVolRaw, 10) : 0;

            if (!p) continue;

            levels.push({
                price: p,
                bid_volume: bVol || 0,
                offer_volume: oVol || 0,
            });
        }

        // Bids: level dengan bid_volume > 0
        result.bids = levels
            .filter((lvl) => lvl.bid_volume > 0)
            .slice(0, 3)
            .map((lvl) => ({
                price: lvl.price,
                volume: lvl.bid_volume,
            }));

        // Offers: level dengan offer_volume > 0
        result.offers = levels
            .filter((lvl) => lvl.offer_volume > 0)
            .slice(0, 3)
            .map((lvl) => ({
                price: lvl.price,
                volume: lvl.offer_volume,
            }));

        return result;
    }

    // fallback: simpan apa adanya
    result.raw = JSON.stringify(payload);
    return result;
}

async function loadLatestOrderbookSnapshot(env, kode) {
    const internalUrl = new URL(`http://internal/ob-latest?kode=${kode}&limit=1`);
    const resp = await latestOrderbook(env, internalUrl);
    if (!resp || resp.status !== 200) return null;

    const data = await resp.json();
    if (!data.snapshots || data.snapshots.length === 0) return null;

    return data.snapshots[0]; // snapshot terbaru
}

// HTTP handler: GET /ob-latest?kode=GOTO&limit=10
async function latestOrderbook(env, url) {
    const kode = (url.searchParams.get("kode") || "GOTO").toUpperCase();
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const H = String(now.getUTCHours()).padStart(2, "0");

    // PRIORITAS: folder jam ini
    const prefixesToTry = [
        `raw_ob/${kode}/${y}/${m}/${d}/${H}/`,
        // fallback: seluruh hari kalau jam ini belum ada
        `raw_ob/${kode}/${y}/${m}/${d}/`,
    ];

    let rows = [];

    for (const prefix of prefixesToTry) {
        const listed = await env.DATA_LAKE.list({
            prefix,
            limit: 200, // cukup besar tapi masih aman
        });

        if (!listed.objects || listed.objects.length === 0) {
            continue; // coba prefix berikutnya
        }

        const texts = await Promise.all(
            listed.objects.map((obj) => env.DATA_LAKE.get(obj.key).then((r) => r.text()))
        );

        for (const text of texts) {
            const trimmed = text.trim();
            if (!trimmed) continue;
            const lines = trimmed.split("\n");
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);

                    const tsMs = obj.ts || Date.now();
                    let payload;

                    if (typeof obj.raw === "string") {
                        // Bisa string JSON atau langsung recinfo pipe
                        try {
                            payload = JSON.parse(obj.raw);
                        } catch {
                            payload = { recinfo: obj.raw };
                        }
                    } else if (obj.raw && typeof obj.raw === "object") {
                        // Bentuk dari taping: { data: {...} } atau langsung payload
                        if (obj.raw.data) {
                            payload = obj.raw.data;
                        } else {
                            payload = obj.raw;
                        }
                    } else {
                        // bentuk aneh → skip baris ini saja
                        continue;
                    }

                    rows.push({ ts: tsMs, payload });

                } catch (e) {
                    // skip baris error
                    continue;
                }
            }
        }

        // kalau sudah dapat rows dari prefix pertama yang berisi, stop
        if (rows.length > 0) break;
    }

    if (rows.length === 0) {
        return new Response(
            JSON.stringify(
                { status: "EMPTY", message: `Tidak ada snapshot valid untuk ${kode}` },
                null,
                2
            ),
            { headers: { "Content-Type": "application/json" } }
        );
    }

    // Urutkan DESC by ts (paling baru dulu)
    rows.sort((a, b) => b.ts - a.ts);

    const slice = rows.slice(0, limit);
    const parsed = slice.map((row) => parseOrderbookPayload(kode, row.ts, row.payload));

    return new Response(
        JSON.stringify(
            {
                status: "OK",
                kode,
                count: parsed.length,
                snapshots: parsed,
            },
            null,
            2
        ),
        { headers: { "Content-Type": "application/json" } }
    );
}


// ========= Helpers kecil =========

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

// TODO: implement aggregasi dari raw_ob → ob_hist
async function stepObHist(env, url) {
    const date = url.searchParams.get("date");
    const kode = url.searchParams.get("kode")?.toUpperCase() || null;

    if (!date) {
        return json({ status: "ERROR", message: "Butuh ?date=YYYY-MM-DD" }, 400);
    }

    // Di sini nanti:
    // 1) list raw_ob prefix per kode & date
    // 2) parsir, bucket per 10s / 30s
    // 3) tulis ke ob_hist/{KODE}/{YYYY}/{MM}/{DD}.jsonl

    // Placeholder dulu biar bisa di-deploy
    return json({
        status: "TODO",
        message: "stepObHist belum diimplementasi",
        date,
        kode,
    });
}

// TODO: implement baca ob_hist buat debug / UI
async function getObHist(env, url) {
    const date = url.searchParams.get("date");
    const kode = (url.searchParams.get("kode") || "GOTO").toUpperCase();

    if (!date) {
        return json({ status: "ERROR", message: "Butuh ?date=YYYY-MM-DD" }, 400);
    }

    // Placeholder: nanti baca dari ob_hist/{KODE}/{YYYY}/{MM}/{DD}.jsonl
    return json({
        status: "TODO",
        message: "getObHist belum diimplementasi",
        date,
        kode,
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (pathname === "/ob-latest") {
            return latestOrderbook(env, url);
        }
        if (pathname === "/step-ob-hist") return stepObHist(env, url);
        if (pathname === "/ob-hist") return getObHist(env, url);
        if (pathname === "/intention") {
            const kode = (url.searchParams.get("kode") || "GOTO").toUpperCase();
            const snap = await loadLatestOrderbookSnapshot(env, kode);
            const score = computeIntentionFromOrderbookSnapshot(snap);

            return new Response(
                JSON.stringify(
                    {
                        kode,
                        intention_score: score,
                        snapshot: snap,   // ⬅️ tambahin ini
                    },
                    null,
                    2
                ),
                { headers: { "Content-Type": "application/json" } }
            );
        }


        return new Response("Not found", { status: 404 });
    },
};
