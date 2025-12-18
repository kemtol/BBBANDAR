export default {
    async fetch(request, env, ctx) {
        // Proxy semua request ke STATE_ENGINE
        return env.STATE_ENGINE.fetch(request);
    },
};