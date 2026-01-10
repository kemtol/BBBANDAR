// livetrade-state-engine/src/index.js
// Synced from Cloudflare deployed version (20 days ago)
import { DurableObject } from "cloudflare:workers";

function withCORS(resp) {
    const headers = new Headers(resp.headers || {});
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "*");
    return new Response(resp.body, {
        status: resp.status || 200,
        headers
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const { pathname } = url;

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "*"
                }
            });
        }

        if (pathname === "/" || pathname === "/health") {
            return withCORS(
                new Response(
                    JSON.stringify({ status: "OK", service: "livetrade-state-engine" }),
                    { headers: { "Content-Type": "application/json" } }
                )
            );
        }

        if (pathname === "/history") {
            const kode = url.searchParams.get("kode");
            const mode = url.searchParams.get("mode") || "swing";
            let limit = parseInt(url.searchParams.get("limit") || "50", 10);
            if (!limit || Number.isNaN(limit)) limit = 50;
            if (!kode) {
                return withCORS(
                    new Response("Butuh ?kode=XXXX", {
                        status: 400,
                        headers: { "Content-Type": "text/plain" }
                    })
                );
            }
            const dummy = {
                kode,
                mode,
                limit,
                count: 0,
                items: [],
                note: "HISTORY_BYPASSED_DO_DEBUG"
            };
            return withCORS(
                new Response(JSON.stringify(dummy, null, 2), {
                    headers: { "Content-Type": "application/json" }
                })
            );
        }

        const id = env.STATE_ENGINE.idFromName("GLOBAL_STATE");
        const stub = env.STATE_ENGINE.get(id);
        try {
            const resp = await stub.fetch(request);
            return withCORS(resp);
        } catch (err) {
            console.error("STATE_ENGINE DO error:", err);
            return withCORS(
                new Response(
                    JSON.stringify(
                        { error: "DO_FETCH_ERROR", message: String(err) },
                        null,
                        2
                    ),
                    {
                        status: 500,
                        headers: { "Content-Type": "application/json" }
                    }
                )
            );
        }
    }
};

export class StateEngine extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.ctx = ctx;
        this.env = env;
        this.storage = ctx.storage;
    }

    async fetch(request) {
        try {
            const url = new URL(request.url);
            const { pathname } = url;
            let kode = url.searchParams.get("kode");
            let mode = url.searchParams.get("mode") || "swing";
            let bodyData = null;

            if (request.method === "POST") {
                try {
                    bodyData = await request.clone().json();
                    if (bodyData.kode) kode = bodyData.kode;
                    if (bodyData.mode) mode = bodyData.mode;
                } catch (e) {
                    console.warn("Gagal parse JSON body:", e);
                }
            }

            if (pathname === "/bulk-update" && request.method === "POST" && bodyData) {
                const items = bodyData.items || [];
                if (items.length > 0) {
                    let ops = {};
                    items.forEach((item) => {
                        ops[item.kode] = item;
                    });
                    await this.storage.put(ops);
                }
                return new Response(JSON.stringify({
                    status: "UPDATED",
                    count: items.length,
                    note: "Data stored securely in Durable Object"
                }, null, 2), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            if (pathname === "/state" && request.method === "GET") {
                if (kode) {
                    const storedData = await this.storage.get(kode);
                    if (storedData) {
                        return new Response(JSON.stringify(storedData, null, 2), {
                            headers: { "Content-Type": "application/json" }
                        });
                    } else {
                        return new Response(JSON.stringify({ error: "No Data Found", kode }, null, 2), {
                            status: 404,
                            headers: { "Content-Type": "application/json" }
                        });
                    }
                }
            }

            const debugPayload = {
                path: pathname,
                method: request.method,
                kode,
                mode,
                received_body: bodyData,
                note: "DEBUG_MINIMAL_FETCH_FIXED (Fallback Route)"
            };
            return new Response(JSON.stringify(debugPayload, null, 2), {
                headers: { "Content-Type": "application/json" }
            });
        } catch (err) {
            return new Response(
                JSON.stringify(
                    { error: "DO_MINIMAL_ERROR", message: String(err) },
                    null,
                    2
                ),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }
    }
}
