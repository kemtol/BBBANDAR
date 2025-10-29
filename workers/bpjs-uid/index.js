import { OtpDO } from './otp-do.js';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event));
});

async function handleRequest(req, event) {
  const url = new URL(req.url);
  const path = url.pathname;
  const env = globalThis.env || event?.bindings || {}; // wrangler sets env differently in dev

  try {
    // Support both legacy paths and new /do_ prefixed paths.
    if ((path === '/register' || path === '/do_register') && req.method === 'POST') {
      const body = await req.json();
      const { phone, publicKeyJwk, name } = body || {};
      if (!phone) return new Response('bad request: missing phone', { status: 400 });

      // If a publicKeyJwk is provided, store it (used by OTP verify flow).
      if (publicKeyJwk) {
        await env.REKO_KV.put(`user:${phone}`, JSON.stringify(publicKeyJwk));
        return new Response(JSON.stringify({ ok: true, stored: 'publicKey' }), { status: 200 });
      }

      // Simple registration flow for testing: store name+phone in KV as a JSON record
      if (name) {
        const rec = { phone: phone, name: name, createdAt: Date.now() };
        await env.REKO_KV.put(`user:${phone}`, JSON.stringify(rec));
        return new Response(JSON.stringify({ ok: true, stored: 'profile' }), { status: 200 });
      }

      return new Response('bad request: missing publicKeyJwk or name', { status: 400 });
    }

    if ((path === '/otp/challenge' || path === '/do_otp/challenge') && req.method === 'POST') {
      const body = await req.json();
      const { phone } = body || {};
      if (!phone) return new Response('bad request', { status: 400 });
      // ensure user exists
      const user = await env.REKO_KV.get(`user:${phone}`);
      if (!user) return new Response(JSON.stringify({ ok: false, reason: 'unknown_user' }), { status: 404 });
      // get DO for this user
      const id = env.OTP_DO_NAMESPACE.idFromName(phone);
      const stub = env.OTP_DO_NAMESPACE.get(id);
      const res = await stub.fetch('https://do/internal/create-nonce', { method: 'POST' });
      const json = await res.json();
      return new Response(JSON.stringify({ ok: true, nonce: json.nonce }), { status: 200 });
    }

    if ((path === '/otp/verify' || path === '/do_otp/verify') && req.method === 'POST') {
      const body = await req.json();
      const { phone, nonce, signature } = body || {};
      if (!phone || !nonce || !signature) return new Response('bad request', { status: 400 });
      // forward to DO for verification and OTP creation
      const id = env.OTP_DO_NAMESPACE.idFromName(phone);
      const stub = env.OTP_DO_NAMESPACE.get(id);
      const res = await stub.fetch('https://do/internal/verify', { method: 'POST', body: JSON.stringify({ phone, nonce, signature }) });
      const json = await res.json();
      return new Response(JSON.stringify(json), { status: res.status });
    }

    // front-end viewer: lookup token in KV to find owning phone, then query DO to consume OTP
    if ((path.startsWith('/otp/view/') || path.startsWith('/do_otp/view/')) && req.method === 'GET') {
      const parts = path.split('/');
      // token is last segment
      const token = parts[parts.length - 1];
      if (!token) return new Response('missing token', { status: 400 });
      const phone = await env.REKO_KV.get(`otp:${token}`);
      if (!phone) return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), { status: 404 });
      const id = env.OTP_DO_NAMESPACE.idFromName(phone);
      const stub = env.OTP_DO_NAMESPACE.get(id);
      // fetch internal view from DO which will atomically return & delete OTP
      const res = await stub.fetch(`https://do/internal/view/${token}`, { method: 'GET' });
      // pass through DO response
      return res;
    }

    return new Response('not found', { status: 404 });
  } catch (e) {
    return new Response('server error: ' + String(e), { status: 500 });
  }
}

export default { OtpDO };
