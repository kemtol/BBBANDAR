// Durable Object that manages per-user OTP state: nonces, OTPs, rate-limits
export class OtpDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // storage is a KV-like durable storage per-object
    this.storage = state.storage;
  }

  // simple helper to generate base64url random
  static randBase64Url(len) {
    const a = crypto.getRandomValues(new Uint8Array(len));
    // base64url encode
    let s = btoa(String.fromCharCode.apply(null, a));
    s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return s;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/internal/create-nonce' && req.method === 'POST') {
        const nonce = OtpDO.randBase64Url(24);
        const now = Date.now();
        await this.storage.put(`nonce:${nonce}`, String(now));
        // keep a short index for cleanup (optional)
        return new Response(JSON.stringify({ nonce }), { status: 200 });
      }

      if (path === '/internal/verify' && req.method === 'POST') {
        const body = await req.json();
        const { phone, nonce, signature } = body || {};
        if (!phone || !nonce || !signature) return new Response('bad request', { status: 400 });

        // check nonce existence
        const n = await this.storage.get(`nonce:${nonce}`);
        if (!n) return new Response(JSON.stringify({ ok: false, reason: 'invalid_or_expired_nonce' }), { status: 400 });

        // get publicKey JWK from shared KV (REKO_KV). Expect key `user:<phone>` => JSON string of { jwk }
        const userKey = await this.env.REKO_KV.get(`user:${phone}`);
        if (!userKey) return new Response(JSON.stringify({ ok: false, reason: 'unknown_user' }), { status: 404 });

        let jwk;
        try { jwk = JSON.parse(userKey); } catch (e) { return new Response('invalid publicKey format', { status: 500 }); }

        // verify signature (ECDSA P-256, SHA-256) where signature is base64url
        try {
          const imported = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
          const sigBuf = OtpDO.base64UrlToBuf(signature);
          const dataBuf = new TextEncoder().encode(nonce);
          const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, sigBuf, dataBuf);
          if (!ok) return new Response(JSON.stringify({ ok: false, reason: 'invalid_signature' }), { status: 403 });

          // signature ok — create single-use OTP and viewToken
          const otp = OtpDO.generateOtp();
          const viewToken = OtpDO.randBase64Url(24);
          const expiresAt = Date.now() + (30 * 1000); // 30s TTL

          await this.storage.put(`otp:${viewToken}`, JSON.stringify({ otp, expiresAt }));
          // also write a KV index so front-facing worker can map token->phone quickly (expires after TTL)
          try {
            await this.env.REKO_KV.put(`otp:${viewToken}`, phone, { expirationTtl: 30 });
          } catch (e) { /* non-fatal */ }

          // remove nonce to prevent replay
          await this.storage.delete(`nonce:${nonce}`);

          return new Response(JSON.stringify({ ok: true, viewToken }), { status: 200 });
        } catch (e) {
          return new Response('verification error', { status: 500 });
        }
      }

      // internal view: return OTP only if token owned by this DO
      if (path.startsWith('/internal/view/') && req.method === 'GET') {
        const parts = path.split('/');
        const token = parts[3];
        if (!token) return new Response('missing token', { status: 400 });
        const rec = await this.storage.get(`otp:${token}`);
        if (!rec) return new Response(JSON.stringify({ ok: false, reason: 'not_found_or_consumed' }), { status: 404 });
        let parsed;
        try { parsed = JSON.parse(rec); } catch(e){ return new Response('invalid stored otp', { status: 500 }); }
        if (Date.now() > parsed.expiresAt) {
          await this.storage.delete(`otp:${token}`);
          try { await this.env.REKO_KV.delete(`otp:${token}`); } catch(_) {}
          return new Response(JSON.stringify({ ok: false, reason: 'expired' }), { status: 410 });
        }
        // consume OTP (delete) and also clean KV index
        await this.storage.delete(`otp:${token}`);
        try { await this.env.REKO_KV.delete(`otp:${token}`); } catch(_) {}
        return new Response(JSON.stringify({ ok: true, otp: parsed.otp }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      return new Response('server error', { status: 500 });
    }
  }

  static generateOtp() {
    const arr = crypto.getRandomValues(new Uint32Array(1));
    const n = String(arr[0] % 1000000).padStart(6, '0');
    return n;
  }

  static base64UrlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
}
