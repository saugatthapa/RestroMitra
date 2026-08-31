import { describe, it, expect } from "vitest";
import {
  isValidLeaveRange,
  leaveDayCount,
  canCancelLeaveRequest,
  canReviewLeaveRequest,
  leaveRangesOverlap,
  leaveDaysWithinPeriod,
} from "./leave";

describe("isValidLeaveRange", () => {
  it("accepts a same-day range", () => {
    expect(isValidLeaveRange("2026-08-20", "2026-08-20")).toBe(true);
  });

  it("accepts endDate after startDate", () => {
    expect(isValidLeaveRange("2026-08-20", "2026-08-25")).toBe(true);
  });

  it("rejects endDate before startDate", () => {
    expect(isValidLeaveRange("2026-08-20", "2026-08-19")).toBe(false);
  });
});

describe("leaveDayCount", () => {
  it("counts a single day as 1", () => {
    expect(leaveDayCount("2026-08-20", "2026-08-20")).toBe(1);
  });

  it("counts an inclusive range correctly", () => {
    expect(leaveDayCount("2026-08-20", "2026-08-22")).toBe(3);
  });

  it("counts correctly across a month boundary", () => {
    expect(leaveDayCount("2026-08-30", "2026-09-02")).toBe(4);
  });
});

describe("canCancelLeaveRequest / canReviewLeaveRequest", () => {
  it("only pending requests can be cancelled or reviewed", () => {
    expect(canCancelLeaveRequest("pending")).toBe(true);
    expect(canReviewLeaveRequest("pending")).toBe(true);
    for (const status of ["approved", "rejected", "cancelled"] as const) {
      expect(canCancelLeaveRequest(status)).toBe(false);
      expect(canReviewLeaveRequest(status)).toBe(false);
    }
  });
});

describe("leaveRangesOverlap", () => {
  it("detects an identical range as overlapping", () => {
    expect(leaveRangesOverlap("2026-08-20", "2026-08-22", "2026-08-20", "2026-08-22")).toBe(true);
  });

  it("detects a partial overlap", () => {
    expect(leaveRangesOverlap("2026-08-20", "2026-08-22", "2026-08-22", "2026-08-25")).toBe(true);
  });

  it("detects one range fully containing another", () => {
    expect(leaveRangesOverlap("2026-08-20", "2026-08-25", "2026-08-21", "2026-08-22")).toBe(true);
  });

  it("returns false for adjacent, non-overlapping ranges", () => {
    expect(leaveRangesOverlap("2026-08-20", "2026-08-22", "2026-08-23", "2026-08-25")).toBe(false);
  });

  it("returns false for ranges far apart", () => {
    expect(leaveRangesOverlap("2026-08-01", "2026-08-05", "2026-09-01", "2026-09-05")).toBe(false);
  });
});

describe("leaveDaysWithinPeriod", () => {
  it("counts every day when the leave range sits fully inside the period", () => {
    expect(leaveDaysWithinPeriod("2026-08-10", "2026-08-12", "2026-08-01", "2026-08-31")).toBe(3);
  });

  it("counts every day when the period sits fully inside the leave range", () => {
    expect(leaveDaysWithinPeriod("2026-08-01", "2026-09-30", "2026-08-10", "2026-08-12")).toBe(3);
  });

  it("clips a leave range that starts before the period", () => {
    expect(leaveDaysWithinPeriod("2026-07-28", "2026-08-03", "2026-08-01", "2026-08-31")).toBe(3);
  });

  it("clips a leave range that ends after the period", () => {
    expect(leaveDaysWithinPeriod("2026-08-29", "2026-09-05", "2026-08-01", "2026-08-31")).toBe(3);
  });

  it("counts a leave range spanning three months, clipped to the middle period", () => {
    expect(leaveDaysWithinPeriod("2026-07-01", "2026-09-30", "2026-08-01", "2026-08-31")).toBe(31);
  });

  it("returns 0 when the ranges don't overlap at all", () => {
    expect(leaveDaysWithinPeriod("2026-06-01", "2026-06-05", "2026-08-01", "2026-08-31")).toBe(0);
  });

  it("returns 0 for adjacent, non-overlapping ranges", () => {
    expect(leaveDaysWithinPeriod("2026-07-25", "2026-07-31", "2026-08-01", "2026-08-31")).toBe(0);
  });

  it("handles an exact single-day overlap at the period boundary", () => {
    expect(leaveDaysWithinPeriod("2026-07-28", "2026-08-01", "2026-08-01", "2026-08-31")).toBe(1);
  });
});
