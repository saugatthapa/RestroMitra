import { describe, it, expect } from "vitest";
import {
  generateDateRange,
  mergeDailySeries,
  computeNetProfitInPaisa,
  computeAverageOrderValueInPaisa,
  previousPeriodRange,
  percentChange,
} from "./reports-helpers";

describe("generateDateRange", () => {
  it("returns every calendar day inclusive of both endpoints", () => {
    expect(generateDateRange("2026-08-01", "2026-08-05")).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
  });

  it("returns a single-element array for a single-day range", () => {
    expect(generateDateRange("2026-08-14", "2026-08-14")).toEqual(["2026-08-14"]);
  });

  it("returns an empty array for a backwards range", () => {
    expect(generateDateRange("2026-08-10", "2026-08-01")).toEqual([]);
  });

  it("returns an empty array for malformed dates rather than throwing", () => {
    expect(generateDateRange("not-a-date", "2026-08-01")).toEqual([]);
  });

  it("crosses a month boundary correctly", () => {
    expect(generateDateRange("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });
});

describe("mergeDailySeries", () => {
  it("fills in 0 for days missing from either lookup", () => {
    const dateRange = ["2026-08-01", "2026-08-02", "2026-08-03"];
    const revenueByDate = { "2026-08-01": 10_000, "2026-08-03": 5_000 };
    const expensesByDate = { "2026-08-02": 2_000 };

    expect(mergeDailySeries(dateRange, revenueByDate, expensesByDate)).toEqual([
      { date: "2026-08-01", revenueInPaisa: 10_000, expensesInPaisa: 0 },
      { date: "2026-08-02", revenueInPaisa: 0, expensesInPaisa: 2_000 },
      { date: "2026-08-03", revenueInPaisa: 5_000, expensesInPaisa: 0 },
    ]);
  });

  it("returns an empty array for an empty date range", () => {
    expect(mergeDailySeries([], { "2026-08-01": 1 }, {})).toEqual([]);
  });
});

describe("computeNetProfitInPaisa", () => {
  it("subtracts expenses from revenue", () => {
    expect(computeNetProfitInPaisa(100_000, 30_000)).toBe(70_000);
  });

  it("can go negative when expenses exceed revenue", () => {
    expect(computeNetProfitInPaisa(10_000, 50_000)).toBe(-40_000);
  });

  it("returns 0 when both are 0", () => {
    expect(computeNetProfitInPaisa(0, 0)).toBe(0);
  });
});

describe("computeAverageOrderValueInPaisa", () => {
  it("divides revenue by order count, rounding to the nearest paisa", () => {
    expect(computeAverageOrderValueInPaisa(1_000, 3)).toBe(333);
  });

  it("returns 0 when there are no orders, rather than dividing by zero", () => {
    expect(computeAverageOrderValueInPaisa(0, 0)).toBe(0);
    expect(computeAverageOrderValueInPaisa(5_000, 0)).toBe(0);
  });

  it("returns 0 for a negative order count guard", () => {
    expect(computeAverageOrderValueInPaisa(5_000, -1)).toBe(0);
  });

  it("rounds .5 up", () => {
    expect(computeAverageOrderValueInPaisa(5, 2)).toBe(3);
  });
});

describe("previousPeriodRange", () => {
  it("returns the immediately-preceding period of the same length for a multi-day range", () => {
    // "Last 7 days" style range (7 days: Aug 8-14) -> the 7 days before it (Aug 1-7)
    expect(previousPeriodRange({ from: "2026-08-08", to: "2026-08-14" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-07",
    });
  });

  it("returns the single preceding day for a single-day range", () => {
    expect(previousPeriodRange({ from: "2026-08-14", to: "2026-08-14" })).toEqual({
      from: "2026-08-13",
      to: "2026-08-13",
    });
  });

  it("handles a 30-day range crossing a month boundary", () => {
    // Jul 17 - Aug 15 (30 days) -> the 30 days before Jul 17: Jun 17 - Jul 16
    expect(previousPeriodRange({ from: "2026-07-17", to: "2026-08-15" })).toEqual({
      from: "2026-06-17",
      to: "2026-07-16",
    });
  });

  it("handles a range crossing a year boundary", () => {
    expect(previousPeriodRange({ from: "2026-01-01", to: "2026-01-03" })).toEqual({
      from: "2025-12-29",
      to: "2025-12-31",
    });
  });
});

describe("percentChange", () => {
  it("computes a positive percentage change", () => {
    expect(percentChange(110, 100)).toBe(10);
  });

  it("computes a negative percentage change", () => {
    expect(percentChange(90, 100)).toBe(-10);
  });

  it("rounds to 2 decimal places", () => {
    expect(percentChange(113, 104)).toBe(8.65); // (113-104)/104 = 8.6538...%
  });

  it("returns 0 when both current and previous are 0 (no change, not 'new')", () => {
    expect(percentChange(0, 0)).toBe(0);
  });

  it("returns null when previous is 0 but current is nonzero (no baseline to compare against)", () => {
    expect(percentChange(500, 0)).toBeNull();
  });

  it("returns -100 when current drops to 0 from a nonzero previous", () => {
    expect(percentChange(0, 500)).toBe(-100);
  });
});
