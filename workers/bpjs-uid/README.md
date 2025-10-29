# OTP Worker (Durable Object + KV prototype)

This folder contains a Cloudflare Worker prototype that implements a single-use OTP provider using:

- REKO_KV (existing KV namespace) to store user public keys (`user:<phone>`) and to index view tokens (`otp:<token>`).
- A per-user Durable Object (`OtpDO`) that manages nonces, verifies signatures, and stores OTP entries atomically.

Files added:
- `wrangler.toml` — worker config for this service (copy your account id / adjust as needed).
- `index.js` — front-facing Worker: endpoints `/register`, `/otp/challenge`, `/otp/verify`, `/otp/view/:token`.
- `otp-do.js` — Durable Object implementation (class `OtpDO`).

Quick usage notes:


This worker exposes both legacy endpoints and `do_`-prefixed paths for easier routing from the app.

Paths (either form accepted):

1. Register a user (simple profile or public key)

   POST /register
   POST /do_register
   Body examples:
   - simple profile: { "phone": "+6281..", "name": "Budi" }
   - public key: { "phone": "+6281..", "publicKeyJwk": { ... } }

2. Get challenge nonce

   POST /otp/challenge
   POST /do_otp/challenge
   Body: { "phone": "+6281.." }

3. Verify signature and create one-time view token

   POST /otp/verify
   POST /do_otp/verify
   Body: { "phone": "+6281..", "nonce": "...", "signature": "base64url(...)" }
   Response: { ok: true, viewToken: "..." }

4. Open the view token URL in a window to retrieve the OTP

   GET /otp/view/:viewToken
   GET /do_otp/view/:viewToken

Notes & assumptions:
- Public keys are stored as JWK in KV under `user:<phone>`. The client should export the public key in JWK format.
- `OtpDO` writes an index entry to KV `otp:<viewToken>` pointing to `phone` with TTL=30s for quick lookup. The DO holds actual OTP data and will atomically consume it.
- This is a prototype. For production consider: stricter rate-limiting in DO, storing additional metadata, CSRF protection on endpoints, and not exposing long-lived secrets in repo.

Deploy with Wrangler from this folder (after updating any account/binding IDs):

```
wrangler publish
```
