// Minimal Cloudflare Worker demonstrating REKO_KV (KV Namespace) and REKO_R2 (R2 bucket)
// Bindings expected in wrangler.toml:
// [[kv_namespaces]] binding = "REKO_KV" id = "..."
// [[r2_buckets]] binding = "REKO_R2" bucket_name = "..."

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === '/') {
    return new Response(
      `Minimal REKO Worker\nAvailable endpoints:\n- /kv?key=<key> → read from REKO_KV\n- /r2?key=<key> → read object from REKO_R2`,
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }

  if (pathname === '/kv') {
    const key = url.searchParams.get('key');
    if (!key) return new Response('missing ?key', { status: 400 });

    try {
      // REKO_KV is the KV binding from wrangler.toml
      const value = await REKO_KV.get(key);
      if (value === null) return new Response('not found', { status: 404 });
      // If you stored JSON, try to parse; otherwise return as text
      try {
        const obj = JSON.parse(value);
        return new Response(JSON.stringify(obj, null, 2), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
      } catch (e) {
        return new Response(value, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    } catch (err) {
      return new Response('KV read error: ' + String(err), { status: 500 });
    }
  }

  if (pathname === '/r2') {
    const key = url.searchParams.get('key');
    if (!key) return new Response('missing ?key', { status: 400 });

    try {
      // REKO_R2 is the R2 binding from wrangler.toml
      const obj = await REKO_R2.get(key);
      if (!obj) return new Response('not found', { status: 404 });

      // obj.body is a ReadableStream — return it directly with appropriate content-type
      const headers = {};
      if (obj.httpMetadata && obj.httpMetadata.contentType) headers['content-type'] = obj.httpMetadata.contentType;
      else headers['content-type'] = 'application/octet-stream';

      return new Response(obj.body, { status: 200, headers });
    } catch (err) {
      return new Response('R2 read error: ' + String(err), { status: 500 });
    }
  }

  return new Response('not found', { status: 404 });
}
