/**
Cloudflare Worker example to create a Stripe Checkout session.

Bindings required (set as secrets or bindings in Cloudflare):
- STRIPE_SECRET: your Stripe secret key (sk_live_... or sk_test_...)
- WORKER_SECRET: simple auth secret expected from client (Bearer)

This example accepts POST /create-checkout with JSON { sku, price, currency, productName, successUrl, cancelUrl }
and returns { url } which the client should redirect to.

Security: keep STRIPE_SECRET and WORKER_SECRET secret in Cloudflare dashboard.
*/

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

function jsonResponse(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type':'application/json' } }); }

function requireAuth(req){
  const a = req.headers.get('authorization') || '';
  const expected = (typeof WORKER_SECRET !== 'undefined') ? WORKER_SECRET : null;
  return expected && a.startsWith('Bearer ') && a.slice(7) === expected;
}

async function handle(req){
  const url = new URL(req.url);
  if(req.method !== 'POST' || url.pathname !== '/create-checkout') return new Response('Not found', { status: 404 });
  if(!requireAuth(req)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try{ body = await req.json(); }catch(e){ return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const price = body.price; // in smallest currency unit? For IDR it's full amount (no cents)
  const currency = body.currency || 'IDR';
  const productName = body.productName || 'Class';
  const successUrl = body.successUrl || 'https://example.com/success';
  const cancelUrl = body.cancelUrl || 'https://example.com/cancel';

  if(!price) return jsonResponse({ error: 'Missing price' }, 400);

  // Create a Checkout Session via Stripe API
  // Note: This example uses the Stripe REST API directly. Alternatively, use the official Stripe SDK in a Node environment.
  const stripeUrl = 'https://api.stripe.com/v1/checkout/sessions';

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('payment_method_types[]', 'card');
  params.append('line_items[0][price_data][currency]', currency);
  // For IDR and currencies without decimals, Stripe expects unit_amount as integer
  params.append('line_items[0][price_data][unit_amount]', String(price));
  params.append('line_items[0][price_data][product_data][name]', productName);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);

  const resp = await fetch(stripeUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const jr = await resp.json();
  if(!resp.ok){
    return jsonResponse({ error: 'Stripe error', details: jr }, 502);
  }

  // jr contains url to redirect the customer
  return jsonResponse({ ok: true, url: jr.url });
}
