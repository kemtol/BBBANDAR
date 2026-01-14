export default {
    async fetch(request, env, ctx) {
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        try {
            const body = await request.json();
            const message = body.message || body.content;

            if (!message) {
                return new Response("Missing message", { status: 400 });
            }

            if (!env.WEBHOOK_URL) {
                console.error("WEBHOOK_URL not configured");
                return new Response("Configuration Error", { status: 500 });
            }

            const response = await fetch(env.WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: message })
            });

            return new Response(JSON.stringify({
                success: response.ok,
                status: response.status
            }), {
                headers: { "Content-Type": "application/json" }
            });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }
};
