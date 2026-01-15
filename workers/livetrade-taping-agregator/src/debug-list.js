
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const date = url.searchParams.get("date") || new Date().toISOString().split('T')[0];
        const [y, m, d] = date.split("-");
        const prefix = `raw_lt/${y}/${m}/${d}/`;

        const listed = await env.DATA_LAKE.list({ prefix, limit: 1000 });

        // Group by Hour to see coverage
        const coverage = {};
        for (const obj of listed.objects) {
            // key format: raw_lt/YYYY/MM/DD/HH/timestamp_uuid.jsonl
            const parts = obj.key.split("/");
            const hh = parts[4]; // HH
            if (!coverage[hh]) coverage[hh] = 0;
            coverage[hh]++;
        }

        return Response.json({
            prefix,
            total: listed.objects.length,
            truncated: listed.truncated,
            coverage
        });
    }
}
