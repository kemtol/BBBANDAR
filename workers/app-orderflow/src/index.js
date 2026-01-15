/**
 * @worker app-orderflow
 * @objective Serves the static assets for the Orderflow Frontend application (SPA) using Cloudflare Workers Assets binding.
 *
 * @endpoints
 * - GET /* -> Serves static files (HTML, JS, CSS) or index.html (public)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: none
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: env.ASSETS
 * - writes: HTTP Response
 *
 * @relations
 * - upstream: Users (Browser)
 * - downstream: Internal APIs (via CORS/Proxy)
 *
 * @success_metrics
 * - Asset load latency
 *
 * @notes
 * - Simple static asset wrapper.
 */
// workers/app-orderflow/src/index.js
export default {
  async fetch(request, env, ctx) {
    // env.ASSETS disediakan dari [assets] di wrangler.toml
    return env.ASSETS.fetch(request);
  },
};