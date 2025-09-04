// =============================================================================
// README — Reko Worker (KV-backed Recommendations API) V.2.1
// =============================================================================
// OVERVIEW
// --------
// Worker ini menyediakan API ringan di atas Cloudflare KV untuk:
// • Ingest CSV rekomendasi intraday (0930 / 1130 / 1415 / 1550) & harian (sum)  //
// • Ambil snapshot terbaru per-slot (“latest”) atau spesifik tanggal (“by-date”) //
// • Menyimpan pointer latest:<slot> agar FE mudah fetch “yang paling baru”      //
// • Memisahkan data Markov vs non-Markov via query ?markov=1 (key terpisah)     //
// • Menyediakan ringkasan harian (summary) yang sudah dinormalisasi             //
// • Endpoint delete berbasis server (tanpa wrangler) utk wipe per hari/rentang  //
//
// BINDINGS & ENV
// --------------
// • env.REKO_KV         : KV namespace (wajib)                                   //
// • env.INGEST_TOKEN    : token Bearer untuk POST ingest/delete (fallback CF_TOKEN)//
// • env.ALLOWED_ORIGIN  : daftar origin CORS, pisah koma (mis: http://127...,https://x) //
//   Gunakan "*" untuk mengizinkan semua origin.                                   //
//
// SKEMA KEY DI KV
// ---------------
// • Per-slot (non-Markov)   : reko:<YYYY-MM-DD>:<slot>         → reko:2025-08-28:1415 //
// • Per-slot (Markov)       : reko:<YYYY-MM-DD>:<slot>:mk      → reko:2025-08-28:1415:mk //
// • Pointer latest          : latest:<slot>                    → latest:1415       //
// • Pointer latest (Markov) : latest:<slot>:mk                 → latest:1415:mk    //
// • Index tanggal           : index:dates                      → array tanggal     //
// • Summary (baru)          : summary:<YYYY-MM-DD>                                 //
// • Summary (legacy)        : reko:<YYYY-MM-DD>:sum                                 //
// • Latest summary          : latest:summary (baru) & latest:sum (legacy)          //
//
// NAMESPACE MARKOV
// ----------------
// • Tambahkan ?markov=1 pada endpoint GET/POST utk namespace Markov.              //
// • Tanpa ?markov=1 → namespace non-Markov (kompatibel versi lama).               //
//
// FORMAT PAYLOAD TERSIMPAN (INGEST SLOT)
// --------------------------------------
// • Disimpan sebagai JSON:                                                        //
//   { ok:true, date:"YYYY-MM-DD", slot:"0930|1130|1415|1550", markov:true|undef, //
//     top:<int>, cutoff:"HH:MM", generated_at:"<ISO>", rows:[ {...}, ... ] }     //
//
// FORMAT SUMMARY (INGEST-SUMMARY)
// -------------------------------
// • Disimpan sebagai:                                                             //
//   { ok:true, type:"summary", date, generated_at, rows:[ {ticker,score,rekom,   //
//     p_close,p_am,p_next,p_chain}, ... ] }                                       //
// • Ditulis ke summary:<date> + latest:summary dan legacy reko:<date>:sum + latest:sum //
//
// ENDPOINTS
// ---------
// • POST /api/reko/ingest?date=YYYY-MM-DD&slot=0930[&top=N][&markov=1]            //
//   Header: Authorization: Bearer <INGEST_TOKEN> | Body: text/csv                 //
// • GET  /api/reko/latest?slot=1415[&markov=1]                                    //
// • GET  /api/reko/by-date?date=YYYY-MM-DD&slot=1415[&markov=1]                  //
// • GET  /api/reko/latest-any[?markov=1]                                          //
// • GET  /api/reko/daily?date=YYYY-MM-DD[&markov=1]                               //
// • GET  /api/reko/dates                                                          //
// • GET  /api/candidates[?markov=1]                                               //
// • POST /api/reko/ingest-summary?date=YYYY-MM-DD                                 //
//   Header: Authorization: Bearer <INGEST_TOKEN> | Body: text/csv                 //
// • GET  /api/reko/latest-summary                                                 //
// • POST /api/reko/delete                                                         //
//   Query:                                                                        //
//     - date=YYYY-MM-DD     (hapus 1 tanggal), atau                               //
//     - from=YYYY-MM-DD&to=YYYY-MM-DD (rentang), atau                             //
//     - all=1               (semua tanggal)                                       //
//     - slot=0930|1130|1415|1550|sum (opsional; default semua slot)               //
//     - markov=all|1|0      (default all)                                         //
//     - include_summary=1   (hapus summary & legacy sum)                          //
//     - purge_latest=1      (hapus pointer latest)                                //
//     - dry=1               (preview, tidak menghapus)                            //
//     - confirm=wipe        (wajib utk operasi besar kecuali dry=1)               //
//
// CONTOH CURL (RINGKAS)
// ---------------------
// # Ingest non-Markov                                                                //
// curl -X POST \                                                                    //
//   -H "Authorization: Bearer $CF_TOKEN" \                                          //
//   -H "Content-Type: text/csv" \                                                   //
//   --data-binary @rekomendasi/bpjs_rekomendasi_2025-08-28_1415.csv \               //
//   "$WORKER_BASE/api/reko/ingest?date=2025-08-28&slot=1415"                        //
// # Ingest Markov                                                                   //
// curl -X POST \                                                                    //
//   -H "Authorization: Bearer $CF_TOKEN" \                                          //
//   -H "Content-Type: text/csv" \                                                   //
//   --data-binary @rekomendasi/bpjs_rekomendasi_2025-08-28_1415.csv \               //
//   "$WORKER_BASE/api/reko/ingest?date=2025-08-28&slot=1415&markov=1"               //
// # Latest & By-date                                                                //
// curl "$WORKER_BASE/api/reko/latest?slot=1415"                                     //
// curl "$WORKER_BASE/api/reko/by-date?date=2025-08-28&slot=1415&markov=1"          //
// # Daily & Latest-any                                                              //
// curl "$WORKER_BASE/api/reko/daily?date=2025-08-28"                                //
// curl "$WORKER_BASE/api/reko/latest-any?markov=1"                                  //
// # Candidates & Dates                                                              //
// curl "$WORKER_BASE/api/candidates"                                                //
// curl "$WORKER_BASE/api/reko/dates"                                                //
// # Delete (aman, server-side)                                                      //
// ## Preview hapus semua tanggal (dry run)                                          //
// curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" \                            //
//   "$WORKER_BASE/api/reko/delete?all=1&include_summary=1&purge_latest=1&dry=1"     //
// ## Hapus 1 tanggal (semua varian + summary + latest)                              //
// curl -X POST -H "Authorization: Bearer $CF_TOKEN" \                               //
//   "$WORKER_BASE/api/reko/delete?date=2025-08-28&markov=all&include_summary=1&purge_latest=1&confirm=wipe" //
// ## Hapus rentang tanggal khusus Markov                                            //
// curl -X POST -H "Authorization: Bearer $CF_TOKEN" \                               //
//   "$WORKER_BASE/api/reko/delete?from=2025-08-21&to=2025-08-28&markov=1&include_summary=1&purge_latest=1&confirm=wipe" //
//
//
// AUTENTIKASI & CORS
// ------------------
// • POST (ingest / ingest-summary / delete) wajib Authorization: Bearer <INGEST_TOKEN>. //
// • GET bebas. CORS dikontrol via ALLOWED_ORIGIN; pakai "*" untuk semua origin.    //
//
// CACHE & INDEX
// -------------
// • GET dibekali Cache-Control: public, max-age=60, stale-while-revalidate=300.     //
// • index:dates dipelihara otomatis saat ingest/delete (retensi ±90 hari).         //
//
// TROUBLESHOOTING
// ---------------
// • Latest kosong → cek pointer latest:<slot> / latest:<slot>:mk di Dashboard KV.   //
// • FE baca data lama → cek cache client/CDN & CORS.                                //
// • CSV gagal parse → pastikan baris 1 adalah header dan delimiter koma.            //
// • Data Markov menimpa non-Markov → pastikan pakai ?markov=1 saat upload Markov.  //
// =============================================================================



var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsOrigin = resolveCorsOrigin(request, env);

    if (request.method === "OPTIONS") {
      const allow = corsOrigin || "*";
      const reqHdr = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization";
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allow,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": reqHdr,
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin, Access-Control-Request-Headers"
        }
      });
    }

    try {
      if (request.method === "POST" && url.pathname === "/api/reko/ingest") {
        return ingestCSV(request, env, corsOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/reko/latest") {
        return getLatest(request, env, corsOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/reko/latest-any") {
        return getLatestAny(request, env, corsOrigin); // Markov-aware
      }
      if (request.method === "GET" && url.pathname === "/api/reko/by-date") {
        return getByDate(request, env, corsOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/reko/daily") {
        return getDailyEndpoint(request, env, corsOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/reko/dates") {
        return listDates(env, corsOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/candidates") {
        return getCandidates(request, env, corsOrigin); // Markov-aware
      }
      if (request.method === "POST" && url.pathname === "/api/reko/ingest-summary") {
        return ingestSummary(request, env, corsOrigin);
      }
      if (request.method === "POST" && url.pathname === "/api/reko/delete") {
        return deleteKeys(request, env, corsOrigin); // server-side wipe
      }
      if (request.method === "GET" && url.pathname === "/api/reko/latest-summary") {
        return getLatestSummary(env, corsOrigin);
      }

      return json({ ok: false, error: "not_found" }, 404, corsOrigin || "*");
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500, corsOrigin || "*");
    }
  }
};

/* -------------------------- helpers umum -------------------------- */
function resolveCorsOrigin(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const raw = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.includes("*")) return "*";
  if (!reqOrigin) return "";
  return raw.includes(reqOrigin) ? reqOrigin : "";
}
__name(resolveCorsOrigin, "resolveCorsOrigin");

function json(body, status = 200, origin = "*") {
  const allow = origin && origin.length ? origin : "*";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": allow,
      "Vary": "Origin"
    }
  });
}
__name(json, "json");

function unauthorized(origin) {
  return json({ ok: false, error: "unauthorized" }, 401, origin);
}
__name(unauthorized, "unauthorized");

const DATES_INDEX_KEY = "index:dates";
async function readDateIndex(env) {
  const arr = await env.REKO_KV.get(DATES_INDEX_KEY, { type: "json", cacheTtl: 60 }).catch(() => null);
  return Array.isArray(arr) ? arr : [];
}
__name(readDateIndex, "readDateIndex");

async function upsertDateIndex(env, date, limit = 90) {
  const d = String(date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  const current = await readDateIndex(env);
  if (current.includes(d)) return;
  const next = [...current, d].sort();
  const trimmed = next.slice(-limit);
  await env.REKO_KV.put(DATES_INDEX_KEY, JSON.stringify(trimmed));
}
__name(upsertDateIndex, "upsertDateIndex");

function slotMinutes(slot) {
  const m = String(slot).match(/^(\d{2})(\d{2})$/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
__name(slotMinutes, "slotMinutes");

function cmpDateSlot(a, b) {
  if (a.date !== b.date) return a.date > b.date ? 1 : -1;
  const d = slotMinutes(a.slot) - slotMinutes(b.slot);
  return d === 0 ? 0 : d;
}
__name(cmpDateSlot, "cmpDateSlot");

/* === Markov helpers & penamaan key (DEFINISI TUNGGAL) === */
function parseMk(url) {
  const v = (url.searchParams.get("markov") || "").toLowerCase();
  return v === "1" || v === "true";
}
__name(parseMk, "parseMk");

function keyOf(date, slot, isMk) {
  return `reko:${date}:${slot}${isMk ? ":mk" : ""}`;
}
__name(keyOf, "keyOf");

function latestKeyOf(slot, isMk) {
  return `latest:${slot}${isMk ? ":mk" : ""}`;
}
__name(latestKeyOf, "latestKeyOf");

/* -------------------------- endpoints utama -------------------------- */
async function getLatestAny(request, env, origin) {
  const url = new URL(request.url);
  const isMk = parseMk(url);
  const SLOTS = ["0930", "1130", "1415", "1550"];
  const candidates = [];
  for (const s of SLOTS) {
    const ptr = await env.REKO_KV.get(latestKeyOf(s, isMk), { type: "json", cacheTtl: 60 });
    if (ptr?.date && ptr?.key) candidates.push({ slot: s, date: ptr.date, key: ptr.key });
  }
  if (!candidates.length) return json({ ok: false, error: "not_found" }, 404, origin);
  candidates.sort(cmpDateSlot);
  const best = candidates[candidates.length - 1];
  const data = await env.REKO_KV.get(best.key, { type: "json", cacheTtl: 60 });
  const res = json(data || { ok: false, error: "not_found" }, data ? 200 : 404, origin);
  if (data) res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res;
}
__name(getLatestAny, "getLatestAny");

async function ingestCSV(request, env, origin) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const workerToken = env.INGEST_TOKEN || env.CF_TOKEN;
  if (!token || token !== workerToken) return unauthorized(origin);

  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const slot = url.searchParams.get("slot");
  const top = parseInt(url.searchParams.get("top") || "10", 10);
  const isMk = parseMk(url);

  if (!date || !slot) return json({ ok: false, error: "missing date/slot" }, 400, origin);

  const csvText = await request.text();
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return json({ ok: false, error: "empty_csv" }, 400, origin);
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cols = splitCsvLine(line, headers.length);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h?.trim?.() ? h.trim() : h] = parseMaybeNumber(cols[i]);
    });
    return obj;
  });

  const payload = {
    ok: true,
    date,
    slot,
    markov: isMk || undefined,
    top,
    cutoff: slotToCutoff(slot),
    generated_at: (new Date()).toISOString(),
    rows
  };

  const key = keyOf(date, slot, isMk);
  const latestKey = latestKeyOf(slot, isMk);

  await env.REKO_KV.put(key, JSON.stringify(payload));
  await env.REKO_KV.put(latestKey, JSON.stringify({ date, key }), { expirationTtl: 7 * 24 * 3600 });
  await upsertDateIndex(env, date);

  return json({ ok: true, key }, 200, origin);
}
__name(ingestCSV, "ingestCSV");

async function getLatest(request, env, origin) {
  const url = new URL(request.url);
  const slot = url.searchParams.get("slot") || "0930";
  const isMk = parseMk(url);
  const latest = await env.REKO_KV.get(latestKeyOf(slot, isMk), { type: "json", cacheTtl: 60 });
  if (!latest) return json({ ok: false, error: "not_found" }, 404, origin);
  const data = await env.REKO_KV.get(latest.key, { type: "json", cacheTtl: 60 });
  const res = json(data || { ok: false, error: "not_found" }, data ? 200 : 404, origin);
  if (data) res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res;
}
__name(getLatest, "getLatest");

async function getByDate(request, env, origin) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const slot = url.searchParams.get("slot");
  const isMk = parseMk(url);
  if (!date || !slot) return json({ ok: false, error: "missing date/slot" }, 400, origin);
  const key = keyOf(date, slot, isMk);
  const data = await env.REKO_KV.get(key, { type: "json", cacheTtl: 60 });
  const res = json(data || { ok: false, error: "not_found" }, data ? 200 : 404, origin);
  if (data) res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res;
}
__name(getByDate, "getByDate");

/* === daily & endpointnya === */
const DAILY_SLOTS = ["0930", "1130", "1415", "1550"];
async function getDaily(date, env, isMk = false) {
  const out = {};
  await Promise.all(DAILY_SLOTS.map(async (s) => {
    let v = await env.REKO_KV.get(keyOf(date, s, isMk), { type: "json", cacheTtl: 60 });
    if (v == null) {
      await new Promise((r) => setTimeout(r, 250));
      v = await env.REKO_KV.get(keyOf(date, s, isMk), { type: "json", cacheTtl: 60 });
    }
    out[s] = v;
  }));
  return { date, slots: DAILY_SLOTS, data: out, markov: !!isMk || undefined };
}
__name(getDaily, "getDaily");

async function getDailyEndpoint(request, env, origin) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const isMk = parseMk(url);
  if (!date) return json({ ok: false, error: "missing date" }, 400, origin);
  const payload = await getDaily(date, env, isMk);
  const res = json({ ok: true, ...payload }, 200, origin);
  res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res;
}
__name(getDailyEndpoint, "getDailyEndpoint");

async function listDates(env, origin) {
  try {
    const dates = await readDateIndex(env);
    const res = json({ ok: true, dates }, 200, origin);
    res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res;
  } catch (err) {
    return json({ ok: false, error: "dates_index_error", detail: String(err?.message || err) }, 500, origin);
  }
}
__name(listDates, "listDates");

/* -------------------------- summary -------------------------- */
function normKey(k) {
  return String(k || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/≥|>=/g, "ge")
    .replace(/\s+/g, " ")
    .trim();
}
__name(normKey, "normKey");

function parseNumLoose(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\u00A0/g, " ").replace(/,/g, "").replace(/\s*%$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
__name(parseNumLoose, "parseNumLoose");

function toProb01(v) {
  const n = parseNumLoose(v);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}
__name(toProb01, "toProb01");

function normalizeSummaryPayload(data) {
  if (!data || !Array.isArray(data.rows)) return data;
  const r0 = data.rows[0] || {};
  const already = "ticker" in r0 || "symbol" in r0;
  if (already) return data;
  const normRows = data.rows
    .map((m) => {
      const ticker = String(m["Kode Saham"] ?? m["ticker"] ?? m["Symbol"] ?? m["symbol"] ?? "").toUpperCase();
      const score = parseNumLoose(m["Skor Sistem"] ?? m["score"]);
      const rekom = m["Rekomendasi Singkat"] ?? m["rekomendasi"] ?? m["rekom"] ?? "";
      const p_close = toProb01(m["Peluang Bertahan sampai Tutup"]);
      const p_am = toProb01(m["Peluang Naik ge3% Besok Pagi"] ?? m["Peluang Naik \u22653% Besok Pagi"]);
      const p_next = toProb01(m["Peluang Lanjut Naik Lusa"]);
      const p_chain = toProb01(m["Peluang Total Berantai"]);
      return { ticker, score, rekom, p_close, p_am, p_next, p_chain };
    })
    .filter((r) => r.ticker);
  return { ...data, type: "summary", rows: normRows };
}
__name(normalizeSummaryPayload, "normalizeSummaryPayload");

function splitCsvRow(line) { return line.split(","); }
__name(splitCsvRow, "splitCsvRow");

async function ingestSummary(request, env, origin) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const workerToken = env.INGEST_TOKEN || env.CF_TOKEN;
  if (!token || token !== workerToken) return unauthorized(origin);

  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date) return json({ ok: false, error: "missing date" }, 400, origin);

  const csvText = await request.text();
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return json({ ok: false, error: "empty_csv" }, 400, origin);

  const head = splitCsvRow(lines[0]).map(normKey);
  const rows = lines.slice(1).map((ln) => {
    const cells = splitCsvRow(ln);
    const m = {};
    head.forEach((h, i) => { m[h] = (cells[i] ?? "").trim(); });
    const ticker = (m["kode saham"] || m["ticker"] || m["symbol"] || "").toUpperCase();
    const score = parseNumLoose(m["skor sistem"] ?? m["score"]);
    const rekom = m["rekomendasi singkat"] || m["rekomendasi"] || m["rekom"] || "";
    return {
      ticker,
      score,
      rekom,
      p_close: toProb01(m["peluang bertahan sampai tutup"]),
      p_am: toProb01(m["peluang naik ge3% besok pagi"]),
      p_next: toProb01(m["peluang lanjut naik lusa"]),
      p_chain: toProb01(m["peluang total berantai"])
    };
  }).filter((r) => r.ticker);

  const payload = { ok: true, type: "summary", date, generated_at: (new Date()).toISOString(), rows };

  const keyNew = `summary:${date}`;
  await env.REKO_KV.put(keyNew, JSON.stringify(payload));
  await env.REKO_KV.put("latest:summary", JSON.stringify({ date, key: keyNew }), { expirationTtl: 14 * 24 * 3600 });

  const keyLegacy = `reko:${date}:sum`;
  await env.REKO_KV.put(keyLegacy, JSON.stringify(payload));
  await env.REKO_KV.put("latest:sum", JSON.stringify({ date, key: keyLegacy }), { expirationTtl: 14 * 24 * 3600 });

  await upsertDateIndex(env, date);
  return json({ ok: true, key: keyNew, legacy: keyLegacy }, 200, origin);
}
__name(ingestSummary, "ingestSummary");

async function getLatestSummary(env, origin) {
  let ptr = await env.REKO_KV.get("latest:summary", { type: "json", cacheTtl: 60 });
  if (!ptr?.key) ptr = await env.REKO_KV.get("latest:sum", { type: "json", cacheTtl: 60 });
  if (!ptr?.key) return json({ ok: false, error: "not_found" }, 404, origin);
  let data = await env.REKO_KV.get(ptr.key, { type: "json", cacheTtl: 60 });
  if (!data && /^reko:\d{4}-\d{2}-\d{2}:sum$/.test(ptr.key)) {
    const m = ptr.key.match(/^reko:(\d{4}-\d{2}-\d{2}):sum$/);
    if (m) data = await env.REKO_KV.get(`summary:${m[1]}`, { type: "json", cacheTtl: 60 });
  }
  if (!data) return json({ ok: false, error: "not_found" }, 404, origin);
  const normalized = normalizeSummaryPayload(data);
  const res = json(normalized, 200, origin);
  res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res;
}
__name(getLatestSummary, "getLatestSummary");

async function getCandidates(request, env, origin) {
  const url = new URL(request.url);
  const isMk = parseMk(url);
  const SLOTS = ["0930", "1130", "1415", "1550"];
  const candidates = [];
  for (const s of SLOTS) {
    const ptr = await env.REKO_KV.get(latestKeyOf(s, isMk), { type: "json", cacheTtl: 60 });
    if (ptr?.date && ptr?.key) candidates.push({ slot: s, date: ptr.date, key: ptr.key });
  }
  if (!candidates.length) {
    const res2 = json({ tickers: [], announce_at: null, detail: [] }, 200, origin);
    res2.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res2;
  }
  candidates.sort(cmpDateSlot);
  const best = candidates[candidates.length - 1];
  const latest = await env.REKO_KV.get(best.key, { type: "json", cacheTtl: 60 });
  if (!latest?.rows?.length) {
    const res2 = json({ tickers: [], announce_at: null, detail: [] }, 200, origin);
    res2.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res2;
  }
  const topN = latest.rows.slice(0, 3);
  const detail = topN.map((r) => {
    const tkr = String(r.ticker || "").toUpperCase().replace(/\.JK$/, "");
    const score = isNum(r.score) ? Number(r.score) : null;
    const reasons = [];
    if (isNum(r.daily_return)) reasons.push(`Return Hari Ini ${fmtPct(r.daily_return)}`);
    if (isNum(r.vol_pace)) reasons.push(`Volume pace ${fmtTimes(r.vol_pace)} rata-rata`);
    if (isNum(r.closing_strength)) reasons.push(`Closing strength ${fmtPct(r.closing_strength)}`);
    if (isNum(r.afternoon_power)) reasons.push(`Afternoon power ${fmtPct(r.afternoon_power)}`);
    if (!reasons.length && isNum(r.last)) reasons.push(`Harga terakhir ${Number(r.last).toLocaleString("id-ID")}`);
    return { ticker: tkr, score, reasons };
  });
  const out = {
    tickers: detail.map((d) => d.ticker),
    announce_at: `${latest.date} ${latest.cutoff || "09:05"}:00`,
    detail
  };
  const res = json(out, 200, origin || "*");
  res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res;
}
__name(getCandidates, "getCandidates");

/* -------------------------- delete (server-side wipe) -------------------------- */
// Markov mode tri-state
const markovMode = (url) => {
  const v = (url.searchParams.get("markov") || "all").toLowerCase();
  if (v === "1" || v === "true") return "1";
  if (v === "0" || v === "false") return "0";
  return "all";
};
__name(markovMode, "markovMode");

// List semua key ber-prefix, dengan pagination
async function listKeysAll(env, prefix) {
  const names = [];
  let cursor = undefined;
  do {
    const res = await env.REKO_KV.list({ prefix, cursor });
    (res.keys || []).forEach(k => names.push(k.name));
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return names;
}
__name(listKeysAll, "listKeysAll");

function parseISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null; }
__name(parseISODate, "parseISODate");
function dateInRange(d, from, to) { if (from && d < from) return false; if (to && d > to) return false; return true; }
__name(dateInRange, "dateInRange");

// Hapus 'date' dari index:dates bila tanggal tsb benar-benar kosong
async function pruneDateIndex(env, date) {
  try {
    const still = await env.REKO_KV.list({ prefix: `reko:${date}:` });
    if (still && Array.isArray(still.keys) && still.keys.length > 0) return;
    const arr = await readDateIndex(env);
    const next = arr.filter((d) => d !== date);
    if (next.length !== arr.length) await env.REKO_KV.put("index:dates", JSON.stringify(next));
  } catch {}
}
__name(pruneDateIndex, "pruneDateIndex");

// DELETE API: dukung date / range / all + markov filter + summary + latest + dry run
async function deleteKeys(request, env, origin) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const workerToken = env.INGEST_TOKEN || env.CF_TOKEN;
  if (!token || token !== workerToken) return unauthorized(origin);

  const url = new URL(request.url);

  const allFlag   = (url.searchParams.get("all") || "0") === "1";
  const dateArg   = url.searchParams.get("date") || "";
  const slot      = url.searchParams.get("slot"); // 0930|1130|1415|1550|sum
  const mkMode    = markovMode(url);              // "all"|"1"|"0"
  const includeSummary = (url.searchParams.get("include_summary") || "0") === "1";
  const purgeLatest    = (url.searchParams.get("purge_latest") || "1") !== "0";
  const dryRun    = (url.searchParams.get("dry") || "0") === "1";
  const confirm   = (url.searchParams.get("confirm") || "").toLowerCase(); // "wipe" utk big op

  const fromDate  = parseISODate(url.searchParams.get("from"));
  const toDate    = parseISODate(url.searchParams.get("to"));

  const SLOTS = ["0930","1130","1415","1550","sum"];
  const wantMk = mkMode === "1" ? true : (mkMode === "0" ? false : "all");

  if (slot && !SLOTS.includes(slot)) return json({ ok:false, error:"invalid_slot" }, 400, origin);

  // Safety untuk operasi besar
  const isBigOp = allFlag || fromDate || toDate || (!slot && !dateArg);
  if (isBigOp && confirm !== "wipe" && !dryRun) {
    return json({ ok:false, error:"confirm_required", hint:"Tambahkan &confirm=wipe atau &dry=1 untuk preview." }, 400, origin);
  }

  const toDelete = new Set();
  const pushKeysFor = (d, s, mk) => {
    toDelete.add(keyOf(d, s, mk));
    if (purgeLatest && s !== "sum") toDelete.add(latestKeyOf(s, mk));
    if (purgeLatest && s === "sum") toDelete.add("latest:sum");
  };

  // Case: satu tanggal eksplisit
  if (!allFlag && dateArg) {
    if (!parseISODate(dateArg)) return json({ ok:false, error:"invalid_date" }, 400, origin);
    const date = dateArg;

    if (slot) {
      if (wantMk === "all") { pushKeysFor(date, slot, false); pushKeysFor(date, slot, true); }
      else { pushKeysFor(date, slot, wantMk); }
    } else {
      // enumerate semua slot pada tanggal tsb via list()
      let cursor;
      do {
        const res = await env.REKO_KV.list({ prefix: `reko:${date}:`, cursor });
        (res.keys || []).forEach(k => {
          const name = k.name;
          if (wantMk !== "all") {
            const isMk = name.endsWith(":mk");
            if (isMk !== wantMk) return;
          }
          toDelete.add(name);
        });
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);

      if (purgeLatest) {
        ["0930","1130","1415","1550"].forEach(s => {
          if (wantMk === "all") { toDelete.add(latestKeyOf(s,false)); toDelete.add(latestKeyOf(s,true)); }
          else { toDelete.add(latestKeyOf(s,wantMk)); }
        });
        toDelete.add("latest:sum");
      }
    }

    if (includeSummary) {
      toDelete.add(`summary:${date}`);
      toDelete.add(`reko:${date}:sum`);
      if (purgeLatest) { toDelete.add("latest:sum"); toDelete.add("latest:summary"); }
    }
  } else {
    // Case: rentang / semua
    const idxDates = await readDateIndex(env);
    const setIdx = new Set(idxDates);

    const rekoKeys = await listKeysAll(env, "reko:");
    const datesFound = new Set();

    for (const name of rekoKeys) {
      const m = name.match(/^reko:(\d{4}-\d{2}-\d{2}):([0-9]{4}|sum)(?::mk)?$/);
      if (!m) continue;
      const d = m[1];
      if (!allFlag && !dateInRange(d, fromDate, toDate)) continue;
      datesFound.add(d);
    }
    for (const d of setIdx) {
      if (allFlag || dateInRange(d, fromDate, toDate)) datesFound.add(d);
    }

    for (const d of datesFound) {
      if (slot) {
        if (wantMk === "all") { pushKeysFor(d, slot, false); pushKeysFor(d, slot, true); }
        else { pushKeysFor(d, slot, wantMk); }
      } else {
        let cursor;
        do {
          const res = await env.REKO_KV.list({ prefix: `reko:${d}:`, cursor });
          (res.keys || []).forEach(k => {
            const name = k.name;
            if (wantMk !== "all") {
              const isMk = name.endsWith(":mk");
              if (isMk !== wantMk) return;
            }
            toDelete.add(name);
          });
          cursor = res.list_complete ? undefined : res.cursor;
        } while (cursor);

        if (purgeLatest) {
          ["0930","1130","1415","1550"].forEach(s => {
            if (wantMk === "all") { toDelete.add(latestKeyOf(s,false)); toDelete.add(latestKeyOf(s,true)); }
            else { toDelete.add(latestKeyOf(s,wantMk)); }
          });
          toDelete.add("latest:sum");
        }
      }

      if (includeSummary) {
        toDelete.add(`summary:${d}`);
        toDelete.add(`reko:${d}:sum`);
        if (purgeLatest) { toDelete.add("latest:sum"); toDelete.add("latest:summary"); }
      }
    }

    if (purgeLatest) {
      ["latest:0930","latest:1130","latest:1415","latest:1550","latest:sum","latest:summary",
       "latest:0930:mk","latest:1130:mk","latest:1415:mk","latest:1550:mk"
      ].forEach(k => {
        if (wantMk === true  && !k.endsWith(":mk")) return; // markov only → skip non-:mk
        if (wantMk === false &&  k.endsWith(":mk")) return; // non-markov only → skip :mk
        toDelete.add(k);
      });
    }
  }

  const keys = Array.from(toDelete);
  if (dryRun) return json({ ok:true, dry:true, count: keys.length, sample: keys.slice(0, 50) }, 200, origin);

  let okCount = 0, failCount = 0;
  await Promise.all(keys.map(async (k) => {
    try { await env.REKO_KV.delete(k); okCount++; } catch { failCount++; }
  }));

  const touchedDates = new Set();
  keys.forEach(k => { const m = k.match(/^reko:(\d{4}-\d{2}-\d{2}):/); if (m) touchedDates.add(m[1]); });
  for (const d of touchedDates) await pruneDateIndex(env, d);

  return json({ ok:true, deleted: okCount, failed: failCount, keys }, 200, origin);
}
__name(deleteKeys, "deleteKeys");

/* -------------------------- util parsing -------------------------- */
function isNum(v) { const n = Number(v); return Number.isFinite(n); }
__name(isNum, "isNum");

function fmtPct(v) { const n = Number(v); if (!Number.isFinite(n)) return String(v); const pct = Math.abs(n) <= 1 ? n * 100 : n; return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"; }
__name(fmtPct, "fmtPct");

function fmtTimes(v) { const n = Number(v); if (!Number.isFinite(n)) return String(v); return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "x"; }
__name(fmtTimes, "fmtTimes");

function slotToCutoff(slot) { return ({ "0930":"09:30", "1130":"11:30", "1415":"14:15", "1550":"15:50" })[slot] || slot; }
__name(slotToCutoff, "slotToCutoff");

function parseMaybeNumber(v) {
  if (v == null) return null;
  const t = ("" + v).trim();
  if (t === "") return "";
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : t;
}
__name(parseMaybeNumber, "parseMaybeNumber");

function splitCsvLine(line, expectedCols) {
  const parts = line.split(",");
  while (parts.length < expectedCols) parts.push("");
  return parts;
}
__name(splitCsvLine, "splitCsvLine");

export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
