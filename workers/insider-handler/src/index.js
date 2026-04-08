/**
 * Simple Cloudflare Worker skeleton for insider/person ownership tracker.
 *
 * Endpoints:
 * GET /health
 * GET /api/persons
 * GET /api/persons/:id
 * GET /api/persons/:id/holdings
 * GET /api/persons/:id/summary
 * GET /api/persons/by-alias/:alias
 */

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

function notFound(message = "Not found") {
  return json(
    {
      success: false,
      error: message,
    },
    { status: 404 }
  );
}

function badRequest(message = "Bad request") {
  return json(
    {
      success: false,
      error: message,
    },
    { status: 400 }
  );
}

function serverError(message = "Internal server error", details = null) {
  return json(
    {
      success: false,
      error: message,
      details,
    },
    { status: 500 }
  );
}

async function getLatestSnapshotDate(db) {
  const row = await db
    .prepare(`
      SELECT MAX(snapshot_date) AS snapshot_date
      FROM person_direct_holdings
    `)
    .first();

  return row?.snapshot_date || null;
}

async function listPersons(db) {
  const result = await db
    .prepare(`
      SELECT
        p.id,
        p.canonical_name,
        p.display_name,
        p.nationality,
        p.domicile,
        p.notes
      FROM persons p
      ORDER BY p.display_name ASC
    `)
    .all();

  return result.results || [];
}

async function getPersonById(db, personId) {
  const row = await db
    .prepare(`
      SELECT
        p.id,
        p.canonical_name,
        p.display_name,
        p.nationality,
        p.domicile,
        p.notes
      FROM persons p
      WHERE p.id = ?
      LIMIT 1
    `)
    .bind(personId)
    .first();

  return row || null;
}

async function getPersonByAlias(db, alias) {
  const normalized = String(alias || "").trim().toUpperCase();

  if (!normalized) return null;

  const row = await db
    .prepare(`
      SELECT
        p.id,
        p.canonical_name,
        p.display_name,
        p.nationality,
        p.domicile,
        p.notes,
        a.alias_name,
        a.alias_normalized
      FROM person_aliases a
      JOIN persons p
        ON p.id = a.person_id
      WHERE a.alias_normalized = ?
      LIMIT 1
    `)
    .bind(normalized)
    .first();

  return row || null;
}

async function getPersonSummary(db, personId) {
  const latestSnapshot = await getLatestSnapshotDate(db);

  if (!latestSnapshot) {
    return {
      person_id: Number(personId),
      snapshot_date: null,
      total_emiten: 0,
      total_shares_tercatat: 0,
      max_ownership_pct: 0,
    };
  }

  const row = await db
    .prepare(`
      SELECT
        h.person_id,
        h.snapshot_date,
        COUNT(*) AS total_emiten,
        COALESCE(SUM(h.total_holding_shares), 0) AS total_shares_tercatat,
        COALESCE(MAX(h.percentage), 0) AS max_ownership_pct
      FROM person_direct_holdings h
      WHERE h.person_id = ?
        AND h.snapshot_date = ?
      GROUP BY h.person_id, h.snapshot_date
      LIMIT 1
    `)
    .bind(personId, latestSnapshot)
    .first();

  return (
    row || {
      person_id: Number(personId),
      snapshot_date: latestSnapshot,
      total_emiten: 0,
      total_shares_tercatat: 0,
      max_ownership_pct: 0,
    }
  );
}

async function getPersonHoldings(db, personId) {
  const latestSnapshot = await getLatestSnapshotDate(db);

  if (!latestSnapshot) return [];

  const result = await db
    .prepare(`
      SELECT
        h.id,
        h.snapshot_date,
        i.share_code,
        i.issuer_name,
        h.investor_type_code,
        h.local_foreign,
        h.nationality,
        h.domicile,
        h.holdings_scripless,
        h.holdings_scrip,
        h.total_holding_shares,
        h.percentage,
        h.raw_investor_name,
        h.raw_issuer_name
      FROM person_direct_holdings h
      JOIN issuers i
        ON i.id = h.issuer_id
      WHERE h.person_id = ?
        AND h.snapshot_date = ?
      ORDER BY h.percentage DESC, i.share_code ASC
    `)
    .bind(personId, latestSnapshot)
    .all();

  return result.results || [];
}

function getPathSegments(url) {
  return new URL(url).pathname.split("/").filter(Boolean);
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      }

      if (request.method !== "GET") {
        return badRequest("Only GET is supported in this skeleton");
      }

      if (!env.DB) {
        return serverError("Missing D1 binding", "Expected env.DB");
      }

      const url = new URL(request.url);
      const segments = getPathSegments(request.url);

      // GET /health
      if (url.pathname === "/health") {
        const latestSnapshot = await getLatestSnapshotDate(env.DB);

        return json({
          success: true,
          app: env.APP_NAME || "worker",
          env: env.APP_ENV || "unknown",
          latest_snapshot_date: latestSnapshot,
        });
      }

      // GET /api/persons
      if (url.pathname === "/api/persons") {
        const persons = await listPersons(env.DB);

        return json({
          success: true,
          data: persons,
        });
      }

      // GET /api/persons/by-alias/:alias
      if (
        segments.length === 4 &&
        segments[0] === "api" &&
        segments[1] === "persons" &&
        segments[2] === "by-alias"
      ) {
        const alias = decodeURIComponent(segments[3]);
        const person = await getPersonByAlias(env.DB, alias);

        if (!person) {
          return notFound(`Alias not found: ${alias}`);
        }

        return json({
          success: true,
          data: person,
        });
      }

      // GET /api/persons/:id
      if (
        segments.length === 3 &&
        segments[0] === "api" &&
        segments[1] === "persons"
      ) {
        const personId = Number(segments[2]);

        if (!Number.isInteger(personId) || personId <= 0) {
          return badRequest("Invalid person id");
        }

        const person = await getPersonById(env.DB, personId);

        if (!person) {
          return notFound(`Person not found: ${personId}`);
        }

        return json({
          success: true,
          data: person,
        });
      }

      // GET /api/persons/:id/summary
      if (
        segments.length === 4 &&
        segments[0] === "api" &&
        segments[1] === "persons" &&
        segments[3] === "summary"
      ) {
        const personId = Number(segments[2]);

        if (!Number.isInteger(personId) || personId <= 0) {
          return badRequest("Invalid person id");
        }

        const person = await getPersonById(env.DB, personId);

        if (!person) {
          return notFound(`Person not found: ${personId}`);
        }

        const summary = await getPersonSummary(env.DB, personId);

        return json({
          success: true,
          data: {
            person,
            summary,
          },
        });
      }

      // GET /api/persons/:id/holdings
      if (
        segments.length === 4 &&
        segments[0] === "api" &&
        segments[1] === "persons" &&
        segments[3] === "holdings"
      ) {
        const personId = Number(segments[2]);

        if (!Number.isInteger(personId) || personId <= 0) {
          return badRequest("Invalid person id");
        }

        const person = await getPersonById(env.DB, personId);

        if (!person) {
          return notFound(`Person not found: ${personId}`);
        }

        const holdings = await getPersonHoldings(env.DB, personId);
        const summary = await getPersonSummary(env.DB, personId);

        return json({
          success: true,
          data: {
            person,
            summary,
            holdings,
          },
        });
      }

      return notFound();
    } catch (error) {
      return serverError("Unhandled exception", error?.message || String(error));
    }
  },
};