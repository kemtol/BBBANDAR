/**
 * auth.js — OpenClaw Dashboard shared auth module
 * Credentials stored as SHA-256 hashes only (no plaintext)
 */

const AUTH_EMAIL_HASH = '117ce6000b0f5caf9707d98ecbda6df2026305afc3e391e5e6ac1da8c27deb4c';
const AUTH_PASS_HASH  = '6700c39ab57a9b38e24746578e9ef3e7f19da8f3b2b2b90de98bb6ae119b5af9';

const SESSION_KEY  = 'oc_session';
const SESS_EXPIRY  = 8 * 60 * 60 * 1000;   // 8 hours when not remember-me

async function sha256(text) {
  // crypto.subtle requires HTTPS; fall back to pure-JS for HTTP contexts
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Minimal SHA-256 (RFC 6234) fallback for non-secure origins
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  const r = (n,x) => (x>>>n)|(x<<(32-n));
  const enc = new TextEncoder().encode(text);
  const len = enc.length;
  const bl = (((len+9)>>>6)+1)<<6;
  const m = new Uint8Array(bl);
  m.set(enc); m[len]=0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(bl-4, len*8, false);
  let [h0,h1,h2,h3,h4,h5,h6,h7] = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  for(let off=0;off<bl;off+=64){
    const w = new Uint32Array(64);
    for(let i=0;i<16;i++) w[i]=dv.getUint32(off+i*4,false);
    for(let i=16;i<64;i++){const s0=r(7,w[i-15])^r(18,w[i-15])^(w[i-15]>>>3);const s1=r(17,w[i-2])^r(19,w[i-2])^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}
    let [a,b,c,d,e,f,g,h]=[h0,h1,h2,h3,h4,h5,h6,h7];
    for(let i=0;i<64;i++){const S1=r(6,e)^r(11,e)^r(25,e);const ch=(e&f)^(~e&g);const t1=(h+S1+ch+K[i]+w[i])|0;const S0=r(2,a)^r(13,a)^r(22,a);const mj=(a&b)^(a&c)^(b&c);const t2=(S0+mj)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(v=>(v>>>0).toString(16).padStart(8,'0')).join('');
}

function checkSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) { _redirectLogin(); return false; }
  try {
    const { ts, remember } = JSON.parse(raw);
    if (!remember && Date.now() - ts > SESS_EXPIRY) {
      logout(true);
      return false;
    }
    return true;
  } catch {
    logout(true);
    return false;
  }
}

function setSession(remember) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    ts: Date.now(),
    remember: !!remember
  }));
}

function logout(redirect = true) {
  localStorage.removeItem(SESSION_KEY);
  if (redirect) _redirectLogin();
}

function getSessionInfo() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function _redirectLogin() {
  const base = location.pathname.replace(/\/[^/]*$/, '/');
  window.location.href = base + 'login.html';
}
