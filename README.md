# BBBANDAR — Project notes

Developer helpers
=================

scripts/pull-worker.sh
----------------------

A small helper to download a deployed Cloudflare Worker script into the `scripts/` folder.

What it does:
- Calls the Cloudflare API to fetch the worker script and saves it as `scripts/<WORKER_NAME>.js`.

Required environment variables:
- `CF_ACCOUNT_ID` — your Cloudflare account ID
- `CF_API_TOKEN` — API token with permission to read Worker scripts (Workers:Read or Workers Scripts read scope)
- `CF_WORKER_NAME` — the name of the deployed Worker to fetch

Usage example:

```bash
CF_ACCOUNT_ID=acct_... CF_API_TOKEN=xxxx CF_WORKER_NAME=my-worker ./scripts/pull-worker.sh
```

Notes:
- The script must be executable. If it isn't, run `chmod +x scripts/pull-worker.sh` (I already set this in the repo).
- The helper performs a simple download and writes to `scripts/`. It does not modify your git history or deploy anything.

If you want, I can extend the helper to also fetch worker routes, bindings, or save metadata alongside the script.

Wrangler: quick activation
--------------------------

If you want to use Cloudflare's Wrangler CLI to manage and deploy Workers from this repo, follow these steps.

1) Install Wrangler (recommended: latest v2)

```bash
# using npm (recommended)
npm install -g wrangler

# or using corepack (node >=16.14)
# corepack enable && corepack prepare @cloudflare/wrangler@latest --activate
```

2) Login / configure

```bash
# Login interactively (will open browser)
wrangler login

# or authenticate with an API token and set account id
# create an API token in Cloudflare Dashboard (Workers:Edit or Workers Scripts write/read)
# then set env vars (example):
export CF_API_TOKEN=xxxx
export CF_ACCOUNT_ID=acct_xxx
```

3) Edit `wrangler.toml`

- A template `wrangler.toml` exists in the project root. Edit `name`, `account_id`, `compatibility_date` and any bindings (KV, R2, secrets) as needed.
- If your worker is a module or uses a build step, set `type = "esm"` and point `main` to the entry file.

4) Publish your worker

```bash
# From project root
wrangler publish --name my-worker

# Or use the name in wrangler.toml
wrangler publish
```

5) Helpful commands

- `wrangler dev` — test worker locally with live reload (proxy to local assets)
- `wrangler whoami` — show the current account
- `wrangler tail` — tail logs when your worker is invoked (requires account + worker)

Notes
- Wrangler needs Node.js on your machine to install the CLI. If you prefer not to install globally, install it as a devDependency and run via `npx wrangler ...`.
- If you plan to deploy from CI, create an API token with minimal scopes and export `CF_API_TOKEN` and `CF_ACCOUNT_ID` in CI secrets.

If you want, I can:
- Create a sample `package.json` with `wrangler` as a devDependency and convenient npm scripts.
- Add a sample `src/` structure and a minimal worker entry to test `wrangler dev` locally.
- Wire `scripts/pull-worker.sh` and `wrangler.toml` together by adding an optional `scripts/wrangler-pull.sh` that uses `wrangler whoami` + `wrangler publish` helpers.
