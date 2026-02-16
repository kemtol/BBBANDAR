import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import worker from "../src/index.js"; // default export { fetch() }
import {
  createFootprintEnv,
  SEGMENT_KEY,
  buildSegment,
  defaultCandle
} from "./helpers/footprintEnv.js";

describe("sanity: /footprint-raw-hist fallback behavior", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T03:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("P0 empty + P1 timeline exists => returns fallback-only chart and triggers repair", async () => {
    const env = createFootprintEnv();

    const req = new Request("https://x/footprint-raw-hist?kode=BBRI&date=2026-02-10", { method: "GET" });
    const ctx = { waitUntil: (p) => p };

    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.status).toBe("OK");
    expect(json.is_fallback).toBe(true);
    expect(Array.isArray(json.buckets)).toBe(true);
    expect(Array.isArray(json.tableData)).toBe(true);
    expect(Array.isArray(json.candles)).toBe(true);
    expect(json.is_repairing).toBe(true);

    // CORS header check
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const fetchMock = globalThis.fetch;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [[repairUrl, options]] = fetchMock.mock.calls;
    expect(repairUrl).toContain("livetrade-taping-agregator");
    expect(options?.method).toBe("POST");
  });

  it("respects REPAIR_ENABLED=false kill switch", async () => {
    const env = createFootprintEnv({ repairEnabled: false });

    const req = new Request("https://x/footprint-raw-hist?kode=BBRI&date=2026-02-10", { method: "GET" });
    const ctx = { waitUntil: (p) => p };

    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.status).toBe("OK");
    expect(json.is_fallback).toBe(true);
    expect(json.is_repairing).toBe(false);

    const fetchMock = globalThis.fetch;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects fallback bubble when raw levels are empty but timeline exists", async () => {
    const rawSegments = new Map([
      [
        SEGMENT_KEY,
        buildSegment([
          defaultCandle({ levels: [], vol: 50 })
        ])
      ]
    ]);

    const env = createFootprintEnv({ repairEnabled: false, rawSegments });
    const req = new Request("https://x/footprint-raw-hist?kode=BBRI&date=2026-02-10", { method: "GET" });
    const ctx = { waitUntil: (p) => p };

    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.status).toBe("OK");
    expect(json.is_fallback).toBe(true);

    const fallbackBubble = json.buckets.find((row) => row.is_fallback);
    expect(fallbackBubble).toBeDefined();
    expect(fallbackBubble.t).toBe("09:00");
    expect(fallbackBubble.v).toBe(10);
    expect(fallbackBubble.is_fallback).toBe(true);
  });

  it("synthesizes bubble when no fallback timeline is available", async () => {
    const rawSegments = new Map([
      [
        SEGMENT_KEY,
        buildSegment([
          defaultCandle({ levels: [], vol: 80 })
        ])
      ]
    ]);

    const env = createFootprintEnv({ repairEnabled: false, timeline: null, rawSegments });
    const req = new Request("https://x/footprint-raw-hist?kode=BBRI&date=2026-02-10", { method: "GET" });
    const ctx = { waitUntil: (p) => p };

    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.status).toBe("OK");
    expect(json.is_fallback).toBe(false);

    const syntheticBubble = json.buckets.find((row) => row.is_synthetic);
    expect(syntheticBubble).toBeDefined();
    expect(syntheticBubble.v).toBe(80);
    expect(syntheticBubble.side).toBe("buy");
  });

  it("handles candles missing ohlc payload without crashing", async () => {
    const rawSegments = new Map([
      [
        SEGMENT_KEY,
        buildSegment([
          defaultCandle({
            ohlc: null,
            open: 98,
            close: 102,
            high: 105,
            low: 97,
            levels: [
              { p: 102, bv: 60, av: 20 }
            ]
          })
        ])
      ]
    ]);

    const env = createFootprintEnv({ repairEnabled: false, timeline: null, rawSegments });
    const req = new Request("https://x/footprint-raw-hist?kode=BBRI&date=2026-02-10", { method: "GET" });
    const ctx = { waitUntil: (p) => p };

    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.status).toBe("OK");
    expect(json.is_fallback).toBe(false);

    const candle = json.candles[0];
    expect(candle.o).toBe(98);
    expect(candle.c).toBe(102);
    expect(candle.h).toBeGreaterThanOrEqual(candle.o);
    expect(json.tableData[0].p).toBe(102);

    const historyRow = json.buckets[0];
    expect(historyRow.side).toBe("buy");
  });
});
