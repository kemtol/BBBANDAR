import { describe, it, expect, vi } from "vitest";
import worker, { __test__ } from "../src/index.js";

function createDbStub(rows = []) {
  const calls = [];
  const db = {
    prepare(query) {
      return {
        bind: (...values) => {
          calls.push({ query, values });
          return {
            async all() {
              return { results: rows };
            }
          };
        }
      };
    }
  };

  return { db, calls };
}

describe("buildEmitenQuery", () => {
  it("sets default status and limit", () => {
    const { sql, params } = __test__.buildEmitenQuery({});
    expect(sql).toContain("status = ?");
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual(["ACTIVE", 500]);
  });

  it("omits status filter when requesting all", () => {
    const { sql, params } = __test__.buildEmitenQuery({ status: "all", q: "BRI", sector: "Financial Services", limit: 10 });
    expect(sql).not.toContain("status = ?");
    expect(sql).toContain("sector = ?");
    expect(sql).toContain("ticker LIKE ?");
    expect(params).toEqual(["Financial Services", "%BRI%", 10]);
  });
});

describe("GET /emiten", () => {
  it("returns list of emiten from D1", async () => {
    const sampleRows = [
      {
        ticker: "BBRI.JK",
        sector: "Financial Services",
        industry: "Banks - Regional",
        status: "ACTIVE",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z"
      }
    ];

    const { db, calls } = createDbStub(sampleRows);
    const env = { SSSAHAM_DB: db };
    const req = new Request("https://x/emiten", { method: "GET" });

    const resp = await worker.fetch(req, env, { waitUntil: (p) => p });
    expect(resp.status).toBe(200);
    const payload = await resp.json();
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.meta.count).toBe(1);
    expect(payload.data[0].ticker).toBe("BBRI.JK");

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["ACTIVE", 500]);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("POST /admin/emiten/sync", () => {
  it("proxies request to idx-handler service binding", async () => {
    const serviceResp = { ok: true, summary: { inserted: 2, updated: 1 } };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(serviceResp), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );

    const env = {
      IDX_HANDLER: { fetch: fetchMock },
      IDX_SYNC_TOKEN: "secret-token"
    };

    const req = new Request("https://x/admin/emiten/sync", {
      method: "POST",
      headers: { "x-admin-token": "secret-token" }
    });

    const resp = await worker.fetch(req, env, { waitUntil: (p) => p });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(202);

    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.summary.inserted).toBe(2);
  });
});
