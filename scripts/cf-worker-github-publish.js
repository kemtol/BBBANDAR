/*
Example Cloudflare Worker that accepts authenticated POST requests to publish files
to a GitHub repository by using the GitHub Contents API.

Usage notes:
- Deploy this Worker and set the following environment secrets/bindings:
  - GITHUB_TOKEN: a GitHub personal access token with 'repo' scope for the target repo
  - WORKER_SECRET: a secret string the client must send as Authorization: Bearer <secret>
  - REPO_OWNER: repo owner (string)
  - REPO_NAME: repo name (string)
  - BRANCH: (optional) branch name, default 'main'

Request:
POST /publish
Headers: Authorization: Bearer <WORKER_SECRET>
Body JSON: { path: 'berita/foo.html', content: '<html>..</html>', commitMessage: 'Add article', updateList: true }

The Worker will create/update the file at the repository path, and optionally update /berita/list.json.
*/

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

const GITHUB_API_BASE = 'https://api.github.com';

function jsonResponse(obj, status=200){
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type':'application/json' } });
}

function unauthorized(){ return jsonResponse({ error: 'Unauthorized' }, 401); }

function requireAuth(req){
  const auth = req.headers.get('authorization') || '';
  const expected = (typeof WORKER_SECRET !== 'undefined') ? WORKER_SECRET : null;
  return expected && auth.startsWith('Bearer ') && auth.slice(7) === expected;
}

async function githubGetFile(path, branch){
  const owner = REPO_OWNER || 'your-owner';
  const repo  = REPO_NAME  || 'your-repo';
  const ref = branch || BRANCH || 'main';
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`;
  const resp = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
  if(!resp.ok) return { ok:false, status: resp.status };
  const j = await resp.json();
  // content is base64
  const b64 = (j.content || '').replace(/\n/g,'');
  // decode base64 to UTF-8 string
  let text = '';
  try{
    text = decodeURIComponent(escape(atob(b64)));
  }catch(e){
    // fallback: return raw base64 if decode fails
    text = atob(b64);
  }
  return { ok:true, text, sha: j.sha, encoding: j.encoding, mime: j.type };
}

async function githubPutFile(path, content, message, branch){
  const owner = REPO_OWNER || 'your-owner';
  const repo  = REPO_NAME  || 'your-repo';
  const ref = branch || BRANCH || 'main';
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  // try get existing sha
  let sha = null;
  try{
    const g = await fetch(url + `?ref=${ref}`, { headers:{ 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept':'application/vnd.github.v3+json' } });
    if(g.ok){ const gj = await g.json(); sha = gj.sha; }
  }catch(e){ }

  const body = { message: message || `Update ${path}`, content: btoa(unescape(encodeURIComponent(content))), branch: ref };
  if(sha) body.sha = sha;

  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept':'application/vnd.github.v3+json', 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  const pj = await put.json();
  return { ok: put.ok, status: put.status, json: pj };
}

async function handleRequest(req){
  const url = new URL(req.url);
  const pathname = url.pathname || '/';

  // All endpoints require auth for safety
  if(!requireAuth(req)) return unauthorized();

  if(req.method === 'GET' && pathname === '/list'){
    // return /berita/list.json content as JSON
    const res = await githubGetFile('berita/list.json');
    if(!res.ok) return jsonResponse({ error: 'Not found' }, 404);
    try{
      const arr = JSON.parse(res.text);
      return jsonResponse({ ok:true, list: arr });
    }catch(e){
      return jsonResponse({ error: 'Invalid list.json content' }, 500);
    }
  }

  if(req.method === 'GET' && pathname === '/get'){
    const p = url.searchParams.get('path');
    if(!p) return jsonResponse({ error: 'Missing path parameter' }, 400);
    const res = await githubGetFile(p);
    if(!res.ok) return jsonResponse({ error: 'Not found', status: res.status }, 404);
    // return raw content with text/plain to avoid accidental HTML execution in client
    return new Response(res.text, { status: 200, headers: { 'content-type':'text/plain; charset=utf-8' } });
  }

  if((req.method === 'POST' || req.method === 'PUT') && (pathname === '/publish' || pathname === '/put')){
    let body;
    try{ body = await req.json(); } catch(e){ return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const path = body.path; if(!path) return jsonResponse({ error: 'Missing path' }, 400);
    const content = body.content || '';
    const commitMessage = body.commitMessage || `Update ${path}`;
    const updateList = !!body.updateList;

    const putRes = await githubPutFile(path, content, commitMessage);
    if(!putRes.ok) return jsonResponse({ error: 'GitHub API error', details: putRes.json }, 502);

    // optionally update list.json
    if(updateList){
      try{
        const listPath = 'berita/list.json';
        const listGet = await githubGetFile(listPath);
        let listArr = [];
        let listSha = null;
        if(listGet.ok){ listArr = JSON.parse(listGet.text); }
        const fname = path.split('/').pop();
        if(!listArr.includes(fname)) listArr.unshift(fname);
        await githubPutFile(listPath, JSON.stringify(listArr, null, 2), `Update ${listPath} (add ${fname})`);
      }catch(e){ /* ignore */ }
    }

    return jsonResponse({ ok:true, result: putRes.json });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}
