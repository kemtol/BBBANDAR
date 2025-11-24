Running multiple Workers locally
-------------------------------

This repo contains two Cloudflare Workers projects:

- root worker (configured by `wrangler.toml` in repo root) — your `WORKER_BASE` (`bpjs-reko`).
- OTP worker in `workers/otp-worker` — your `WORKER_BASE_UUID` (`bpks-uid-3380`).

Quick start (one-command)

From the repo root run:

```
./scripts/dev-workers.sh
```

What this does:
- starts the root worker on port 8787 and writes logs to `./logs/reko-dev.log`
- starts the OTP worker on port 8788 and writes logs to `./logs/otp-dev.log`
- writes PIDs to `./tmp/*.pid`

Notes & tips
- Ensure `wrangler` is installed and configured (logged in) before running the script.
- If a worker requires secrets, set them using `wrangler secret put` in the appropriate worker folder before starting.
- The script is a convenience for development. For production deploy use `wrangler publish` per worker folder.
