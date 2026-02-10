
const { R2 } = require("cloudflare");

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");

        if (!key) return new Response("Missing key param", { status: 400 });

        const obj = await env.DATA_LAKE.get(key);
        if (!obj) return new Response("Not found", { status: 404 });

        return new Response(obj.body, {
            headers: { "Content-Type": "application/json" }
        });
    }
};
