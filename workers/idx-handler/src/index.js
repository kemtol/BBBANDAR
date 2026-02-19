const IDX_EMITEN_URL = "https://www.idx.co.id/primary/Helper/GetEmiten?emitenType=*";
const IDX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.idx.co.id/"
};

const TICKER_KEYS = ["KodeEmiten", "kodeEmiten", "Kode_Saham", "Kode", "Code", "ticker"];
const SECTOR_KEYS = ["Sektor", "Sector", "NamaSektor", "sector", "sektor", "SectorName"];
const INDUSTRY_KEYS = ["SubSektor", "SubSector", "Industry", "Industri", "NamaSubSektor", "SubSubSektor", "sub_industry"];
const STATUS_KEYS = ["Status", "StatusPerusahaan", "StatusEmiten", "status", "KodeStatus", "statusEmiten"];

export default {
  async fetch(req, env, ctx) {
    try {
      if (req.method === "OPTIONS") {
        return withCORS(new Response(null, { status: 204 }));
      }

      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return json({ ok: true, service: "idx-handler" });
      }

      if (url.pathname === "/internal/idx/sync-emiten" && req.method === "POST") {
        const auth = validateInternalAuth(req, env);
        if (!auth.ok) return auth.response;

        const result = await syncEmiten(env);
        return json({ ok: true, ...result });
      }

      return json({ error: "Not Found", path: url.pathname }, 404);
    } catch (err) {
      console.error("[IDX] Worker error", err);
      return json({ error: "Internal Error", details: err.message || String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncEmiten(env, { reason: "cron" })
        .then((summary) => {
          console.log(`[IDX] Cron sync completed: inserted=${summary.summary.inserted}, updated=${summary.summary.updated}`);
        })
        .catch((err) => {
          console.error("[IDX] Cron sync failed", err);
        })
    );
  }
};

function withCORS(resp) {
  const headers = new Headers(resp.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  return new Response(resp.body, { status: resp.status, headers });
}

function json(data, status = 200) {
  return withCORS(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    })
  );
}

function validateInternalAuth(req, env) {
  const expected = normalizeToken(env.IDX_SYNC_TOKEN);
  if (!expected) return { ok: true };

  const provided = normalizeToken(req.headers.get("x-admin-token")) || extractBearer(req.headers.get("authorization"));
  if (provided && provided === expected) return { ok: true };

  return { ok: false, response: json({ error: "Unauthorized" }, 401) };
}

function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function extractBearer(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeToken(match[1]) : null;
}

async function syncEmiten(env, { reason = "manual", fetcher = fetch } = {}) {
  if (!env?.SSSAHAM_DB?.prepare) {
    throw new Error("SSSAHAM_DB binding is missing");
  }

  const idxRaw = await fetchIdxEmiten(fetcher);
  const normalized = dedupeEmitens(idxRaw.map(normalizeIdxRecord).filter(Boolean));

  console.log(`[IDX] Sync start reason=${reason}, upstream=${idxRaw.length}, normalized=${normalized.length}`);

  const existingMap = await loadExistingEmitens(env.SSSAHAM_DB);
  const summary = {
    total_idx: idxRaw.length,
    normalized: normalized.length,
    existing: existingMap.size,
    inserted: 0,
    updated: 0,
    skipped: 0
  };

  const nowIso = new Date().toISOString();

  for (const emiten of normalized) {
    const current = existingMap.get(emiten.ticker);
    let action = "synced";

    if (!current) {
      await insertEmiten(env.SSSAHAM_DB, emiten, nowIso);
      existingMap.set(emiten.ticker, { ...emiten });
      summary.inserted += 1;
      action = "inserted";
    } else {
      const updates = buildUpdatePayload(current, emiten);
      if (!updates) {
        summary.skipped += 1;
        action = "synced";
      } else {
        await updateEmiten(env.SSSAHAM_DB, emiten.ticker, updates, nowIso);
        existingMap.set(emiten.ticker, { ...current, ...updates });
        summary.updated += 1;
        action = "updated";
      }
    }

    const latest = existingMap.get(emiten.ticker) || {
      sector: emiten.sector ?? null,
      industry: emiten.industry ?? null,
      status: emiten.status ?? "ACTIVE"
    };

    await recordSyncMeta(env.SSSAHAM_DB, {
      ticker: emiten.ticker,
      last_synced_at: nowIso,
      last_action: action,
      last_status: resolveStatus(latest.status, emiten.status, current?.status),
      last_source: reason,
      last_sector: resolveText(latest.sector, emiten.sector, current?.sector),
      last_industry: resolveText(latest.industry, emiten.industry, current?.industry),
      updated_at: nowIso
    });
  }

  const result = { synced_at: nowIso, summary };
  console.log(`[IDX] Sync done: inserted=${summary.inserted}, updated=${summary.updated}, skipped=${summary.skipped}`);
  return result;
}

async function fetchIdxEmiten(fetcher) {
  const resp = await fetcher(IDX_EMITEN_URL, {
    method: "GET",
    headers: IDX_HEADERS
  });

  const body = await resp.text();

  if (!resp.ok) {
    throw new Error(`[IDX] Failed to fetch emiten list: ${resp.status} ${resp.statusText}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`[IDX] Unexpected payload format: ${err.message}`);
  }

  const list = unwrapIdxPayload(parsed);
  if (!Array.isArray(list)) {
    throw new Error("[IDX] Payload is not an array");
  }

  return list;
}

function unwrapIdxPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.Data)) return payload.Data;
  return [];
}

function dedupeEmitens(records) {
  const map = new Map();
  for (const item of records) {
    if (!item?.ticker) continue;
    map.set(item.ticker, item);
  }
  return Array.from(map.values());
}

function normalizeIdxRecord(raw) {
  const ticker = ensureTickerFormat(pick(raw, TICKER_KEYS));
  if (!ticker) return null;

  const sector = sanitizeText(pick(raw, SECTOR_KEYS));
  const industry = sanitizeText(pick(raw, INDUSTRY_KEYS));
  const status = normalizeStatus(pick(raw, STATUS_KEYS));

  return { ticker, sector, industry, status };
}

function pick(obj, keys) {
  if (!obj) return null;
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }
  return null;
}

function ensureTickerFormat(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return null;
  if (trimmed.endsWith(".JK")) return trimmed;
  const alnum = trimmed.replace(/[^A-Z0-9]/g, "");
  if (!alnum) return null;
  return `${alnum}.JK`;
}

function sanitizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeStatus(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!text) return "ACTIVE";

  const directMap = {
    A: "ACTIVE",
    N: "ACTIVE",
    S: "SUSPENDED",
    SP: "SUSPENDED",
    SUS: "SUSPENDED",
    I: "SUSPENDED",
    D: "DELISTED",
    DEL: "DELISTED"
  };

  if (directMap[text]) return directMap[text];
  if (text.includes("SUSP")) return "SUSPENDED";
  if (text.includes("HENTI") || text.includes("HOLD")) return "SUSPENDED";
  if (text.includes("DEL")) return "DELISTED";
  if (text.includes("LIST")) return "DELISTED";
  return "ACTIVE";
}

async function loadExistingEmitens(db) {
  const map = new Map();
  const { results } = await db.prepare("SELECT ticker, sector, industry, status FROM emiten").all();
  for (const row of results || []) {
    if (!row?.ticker) continue;
    const ticker = row.ticker.toUpperCase();
    map.set(ticker, {
      ticker,
      sector: sanitizeText(row.sector),
      industry: sanitizeText(row.industry),
      status: row.status || "ACTIVE"
    });
  }
  return map;
}

async function insertEmiten(db, emiten, nowIso) {
  await db
    .prepare(
      "INSERT INTO emiten (ticker, sector, industry, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(emiten.ticker, emiten.sector ?? null, emiten.industry ?? null, emiten.status ?? "ACTIVE", nowIso, nowIso)
    .run();
}

async function updateEmiten(db, ticker, updates, nowIso) {
  const sets = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(updates, "sector")) {
    sets.push("sector = ?");
    values.push(updates.sector ?? null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "industry")) {
    sets.push("industry = ?");
    values.push(updates.industry ?? null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "status")) {
    sets.push("status = ?");
    values.push(updates.status ?? "ACTIVE");
  }

  if (!sets.length) return;

  sets.push("updated_at = ?");
  values.push(nowIso);
  values.push(ticker);

  await db
    .prepare(`UPDATE emiten SET ${sets.join(", ")} WHERE ticker = ?`)
    .bind(...values)
    .run();
}

function buildUpdatePayload(current, next) {
  const updates = {};
  let changed = false;

  if (next.sector && next.sector !== current.sector) {
    updates.sector = next.sector;
    changed = true;
  }

  if (next.industry && next.industry !== current.industry) {
    updates.industry = next.industry;
    changed = true;
  }

  const desiredStatus = next.status || "ACTIVE";
  if (desiredStatus !== (current.status || "ACTIVE")) {
    updates.status = desiredStatus;
    changed = true;
  }

  return changed ? updates : null;
}

async function recordSyncMeta(db, meta) {
  await db
    .prepare(`
      INSERT INTO emiten_sync_status
        (ticker, last_synced_at, last_action, last_status, last_source, last_sector, last_industry, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        last_action = excluded.last_action,
        last_status = excluded.last_status,
        last_source = excluded.last_source,
        last_sector = excluded.last_sector,
        last_industry = excluded.last_industry,
        updated_at = excluded.updated_at
    `)
    .bind(
      meta.ticker,
      meta.last_synced_at,
      meta.last_action,
      meta.last_status,
      meta.last_source,
      meta.last_sector,
      meta.last_industry,
      meta.updated_at
    )
    .run();
}

function resolveText(...sources) {
  for (const source of sources) {
    const value = sanitizeText(source);
    if (value) return value;
  }
  return null;
}

function resolveStatus(...sources) {
  for (const source of sources) {
    if (typeof source === "string") {
      const trimmed = source.trim().toUpperCase();
      if (trimmed) return trimmed;
    }
  }
  return "ACTIVE";
}

export const __test__ = {
  normalizeIdxRecord,
  ensureTickerFormat,
  normalizeStatus,
  buildUpdatePayload,
  dedupeEmitens,
  unwrapIdxPayload
};
