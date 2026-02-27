/*
  E2E deployed test: Catalyst sync -> raw snapshot stored in R2 (SSSAHAM_EMITEN)

  Usage:
    IDX_SYNC_TOKEN=... node test/e2e.catalyst.deployed.mjs

  Optional env:
    API_SAHAM_BASE_URL=https://api-saham.mkemalw.workers.dev
    CATALYST_FROM=2026-03-01
    CATALYST_TO=2026-03-04
    CATALYST_DETAIL_LIMIT=30
*/

const BASE = (process.env.API_SAHAM_BASE_URL || "https://api-saham.mkemalw.workers.dev").replace(/\/$/, "");
const TOKEN = (process.env.IDX_SYNC_TOKEN || "").trim();
const FROM = process.env.CATALYST_FROM || "2026-03-01";
const TO = process.env.CATALYST_TO || "2026-03-04";
const DETAIL_LIMIT = Number(process.env.CATALYST_DETAIL_LIMIT || 30);

function fail(message, extra) {
  console.error(`❌ ${message}`);
  if (extra !== undefined) console.error(extra);
  process.exit(1);
}

function ok(message) {
  console.log(`✅ ${message}`);
}

async function httpJson(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // keep raw text fallback
  }
  return { resp, data, text };
}

if (!TOKEN) {
  fail("IDX_SYNC_TOKEN belum di-set. Set env IDX_SYNC_TOKEN terlebih dahulu.");
}

console.log("🔎 Base URL:", BASE);
console.log("🔎 Range:", FROM, "->", TO);

const syncUrl = `${BASE}/dashboard/catalyst/sync-ipot`;
const syncPayload = {
  from: FROM,
  to: TO,
  include_detail: true,
  detail_limit: DETAIL_LIMIT
};

const { resp: syncResp, data: syncData, text: syncText } = await httpJson(syncUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-admin-token": TOKEN
  },
  body: JSON.stringify(syncPayload)
});

if (!syncResp.ok) {
  fail(`sync endpoint gagal (${syncResp.status})`, syncData || syncText);
}

if (!syncData?.ok) {
  fail("sync response ok=false", syncData || syncText);
}

ok(`sync berhasil, parsed_events=${syncData.parsed_events}, raw_saved=${syncData.raw_snapshot_saved}`);

const keys = Array.isArray(syncData.raw_snapshot_keys) ? syncData.raw_snapshot_keys : [];
if (keys.length === 0) {
  fail("raw_snapshot_keys kosong. Tidak ada snapshot yang tersimpan.", syncData);
}

const pickByQueryType = (type) => keys.find((k) => k.includes(`/query=${type}/`));
const keyCalca = pickByQueryType("calca");
const keySector = pickByQueryType("sector");
const keyDetail = pickByQueryType("ca_detail");

if (!keyCalca) fail("Snapshot calca tidak ditemukan pada raw_snapshot_keys", keys);
ok("snapshot calca ditemukan");
if (keySector) ok("snapshot sector ditemukan");
if (keyDetail) ok("snapshot ca_detail ditemukan");

async function verifyR2Key(key, label) {
  const debugUrl = `${BASE}/debug/emiten-file?key=${encodeURIComponent(key)}`;
  const r = await fetch(debugUrl, {
    headers: { "x-admin-token": TOKEN }
  });

  const body = await r.text();
  if (!r.ok) {
    fail(`debug fetch gagal untuk ${label} (${r.status})`, body);
  }

  const firstLine = body.split("\n").find(Boolean);
  if (!firstLine) fail(`snapshot ${label} kosong`, body);

  let meta;
  try {
    meta = JSON.parse(firstLine);
  } catch {
    fail(`snapshot ${label} bukan NDJSON valid`, firstLine);
  }

  if (meta?.kind !== "meta") fail(`snapshot ${label} tidak memiliki header meta`, meta);
  if (!meta?.query_type) fail(`snapshot ${label} tidak memiliki query_type`, meta);

  ok(`R2 snapshot ${label} terverifikasi: query_type=${meta.query_type}, total_records=${meta.total_records}`);
}

await verifyR2Key(keyCalca, "calca");
if (keySector) await verifyR2Key(keySector, "sector");
if (keyDetail) await verifyR2Key(keyDetail, "ca_detail");

const catalystUrl = `${BASE}/dashboard/catalyst?limit=30`;
const { resp: catResp, data: catData, text: catText } = await httpJson(catalystUrl);
if (!catResp.ok) {
  fail(`GET /dashboard/catalyst gagal (${catResp.status})`, catData || catText);
}

if (!Array.isArray(catData?.items)) {
  fail("Response /dashboard/catalyst tidak memiliki items[]", catData || catText);
}

ok(`frontend endpoint OK: items=${catData.items.length}`);
console.log("🎉 E2E selesai: sync -> raw snapshot R2 -> readback -> frontend endpoint");
