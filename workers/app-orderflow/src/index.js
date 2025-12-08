// workers/app-orderflow/src/index.js
export default {
  async fetch(request, env, ctx) {
    // env.ASSETS disediakan dari [assets] di wrangler.toml
    return env.ASSETS.fetch(request);
  },
};