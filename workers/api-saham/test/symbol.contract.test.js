import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import worker from "../src/index.js";
import {
  createFootprintEnv,
  createDbStub,
  buildSegment,
  defaultCandle,
  SEGMENT_KEY,
  defaultTimeline
} from "./helpers/footprintEnv.js";

function baseDbRows({ lastDate = "2026-02-10", close = 101, vol = 1000, net = 250, open = 100, state } = {}) {
  const stateResult = state === undefined ? { quadrant_st: "ACCUMULATION", score: 0.82 } : state;
  return createDbStub({
    first: [
      { match: "SELECT MAX(date)", result: { last_date: lastDate } },
      { match: "ORDER BY time_key DESC", result: { close } },
      {
        match: "SELECT MIN(low)",
        result: {
          low: 99,
          high: 105,
          vol,
          net_vol: net,
          open
        }
      },
      {
        match: "SELECT state as quadrant_st",
        result: stateResult
      }
    ]
  });
}

describe("contract: /symbol", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T03:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns snapshot and state when raw data is healthy", async () => {
    const rawSegments = new Map([
      [SEGMENT_KEY, buildSegment([defaultCandle()])]
    ]);

    const env = createFootprintEnv({
      rawSegments,
      timeline: null,
      db: baseDbRows()
    });

    const req = new Request("https://x/symbol?kode=BBRI");
    const resp = await worker.fetch(req, env, { waitUntil: (p) => p });
    expect(resp.status).toBe(200);

    const payload = await resp.json();
    expect(payload.snapshot.ticker).toBe("BBRI");
    expect(payload.snapshot.vol).toBe(1000);
    expect(payload.snapshot.net_vol).toBe(250);
    expect(payload.state.quadrant).toBe(1);
    expect(payload.is_fallback).toBe(false);
    expect(payload.is_repairing).toBe(false);
  });

  it("falls back to timeline when raw levels missing and keeps repair off when kill switch false", async () => {
    const rawSegments = new Map([
      [SEGMENT_KEY, buildSegment([defaultCandle({ levels: [], vol: 50 })])]
    ]);

    const env = createFootprintEnv({
      rawSegments,
      timeline: defaultTimeline,
      repairEnabled: false,
      db: baseDbRows({ vol: 50, net: 10, state: null })
    });

    const fetchMock = globalThis.fetch;
    fetchMock.mockClear();

    const req = new Request("https://x/symbol?kode=BBRI");
    const resp = await worker.fetch(req, env, { waitUntil: (p) => p });
    expect(resp.status).toBe(200);

    const payload = await resp.json();
    expect(payload.is_fallback).toBe(true);
    expect(payload.state).toBeNull();
    expect(payload.is_repairing).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
