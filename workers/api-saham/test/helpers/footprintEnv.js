import { vi } from "vitest";

export const SEGMENT_KEY = "footprint/BBRI/1m/2026/02/10/02.jsonl";

export const defaultTimeline = [
  { t: "09:00", p: 100, v: 10, a: 2, m: 60 },
  { t: "09:05", p: 101, v: 12, a: -1, m: 45 }
];

export function buildSegment(candles) {
  return candles.map((c) => JSON.stringify(c)).join("\n");
}

export function defaultCandle(overrides = {}) {
  return {
    t0: Date.parse("2026-02-10T02:00:00Z"),
    vol: 100,
    delta: 40,
    ohlc: { o: 100, h: 102, l: 99, c: 101 },
    levels: [
      { p: 101, bv: 60, av: 40 }
    ],
    ...overrides
  };
}

export function createDbStub({ first = [] } = {}) {
  const matchers = first.map((entry) => ({
    match: entry.match,
    result: entry.result
  }));

  return {
    prepare(query) {
      const matcher = matchers.find(({ match }) =>
        typeof match === "string" ? query.includes(match) : match.test(query)
      );

      return {
        bind: () => ({
          first: async () =>
            typeof matcher?.result === "function" ? matcher.result(query) : matcher?.result || null
        })
      };
    }
  };
}

export function createFootprintEnv({
  repairEnabled = true,
  timeline = defaultTimeline,
  rawSegments = new Map(),
  processedDaily = new Map(),
  ticker = "BBRI",
  db = createDbStub()
} = {}) {
  const timelineAvailable = timeline !== null && timeline !== undefined;
  const segmentMap = rawSegments;
  const processedMap = processedDaily;
  const timelineKey = `processed/${ticker}/intraday.json`;

  return {
    REPAIR_ENABLED: repairEnabled ? "true" : "false",
    FOOTPRINT_BUCKET: {
      async get(key) {
        if (segmentMap.has(key)) {
          const payload = segmentMap.get(key);
          if (typeof payload === "string") {
            return {
              text: async () => payload
            };
          }
          if (typeof payload === "object" && payload !== null) {
            return {
              json: async () => payload
            };
          }
        }

        if (processedMap.has(key)) {
          return {
            json: async () => processedMap.get(key)
          };
        }

        return null;
      },
      async head(key) {
        return segmentMap.has(key) ? {} : null;
      }
    },
    SSSAHAM_EMITEN: {
      async get(key) {
        if (timelineAvailable && key === timelineKey) {
          return {
            json: async () => ({ timeline }),
            text: async () => JSON.stringify({ timeline })
          };
        }
        return null;
      },
      head: async () => null
    },
    SSSAHAM_DB: db
  };
}

// Ensure fetch stub exists for any test importing this helper.
if (!globalThis.fetch) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
}
