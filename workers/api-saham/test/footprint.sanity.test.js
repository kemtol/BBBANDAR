import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __test__ } from "../src/index.js"; // sesuaikan path

function mkCandle({ t0, vol = 0 }) {
  return {
    t0: typeof t0 === "number" ? t0 : new Date(t0).getTime(),
    vol,
    delta: 0,
    ohlc: { o: 100, h: 100, l: 100, c: 100 },
    levels: [] // sengaja kosong untuk beberapa test
  };
}

describe("sanity: completeness + repair gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("SPARSE_DATA should not force repair (shouldRepairFootprint.repair = false)", () => {
    // set "now" arbitrary, tapi past day completeness uses fixed 84 buckets
    vi.setSystemTime(new Date("2026-02-15T03:00:00Z"));

    const dateStr = "2026-02-10"; // past day
    const candles = [
      mkCandle({ t0: "2026-02-10T02:00:00Z", vol: 10 }),
      mkCandle({ t0: "2026-02-10T02:30:00Z", vol: 10 }),
      mkCandle({ t0: "2026-02-10T03:00:00Z", vol: 10 })
    ]; // tradedRows = 3 => sparse (threshold ~42)

    const completion = __test__.checkDataCompleteness(candles, dateStr);
    expect(completion.isIncomplete).toBe(true);
    expect(completion.reason).toBe("SPARSE_DATA");

    const decision = __test__.shouldRepairFootprint({
      candles,
      dateStr,
      completion,
      missingSessionHours: 8,
      brokenFound: false
    });

    // ini yang penting: sparse dianggap normal, jangan repair
    expect(decision.repair).toBe(false);
    expect(decision.reason).toBe("SPARSE_DATA");
  });

  it("Past day incomplete (non-sparse) should allow repair", () => {
    vi.setSystemTime(new Date("2026-02-15T03:00:00Z"));

    const dateStr = "2026-02-10";
    // bikin tradedRows banyak supaya tidak sparse, tapi last traded < 15:50 WIB
    // 15:00 WIB = 08:00Z (masih < 15:50)
    const candles = Array.from({ length: 60 }, (_, i) =>
      mkCandle({ t0: new Date(`2026-02-10T02:${String(i%60).padStart(2,"0")}:00Z`).getTime(), vol: 10 })
    );
    candles[candles.length - 1] = mkCandle({ t0: "2026-02-10T08:00:00Z", vol: 10 });

    const completion = __test__.checkDataCompleteness(candles, dateStr);
    expect(completion.isIncomplete).toBe(true);
    expect(completion.reason).toBe("PAST_DAY_INCOMPLETE");

    const decision = __test__.shouldRepairFootprint({
      candles,
      dateStr,
      completion,
      missingSessionHours: 3,
      brokenFound: false
    });

    expect(decision.repair).toBe(true);
    expect(decision.priority).toBe("high"); // incompleteNotSparse + ada data
  });
});
