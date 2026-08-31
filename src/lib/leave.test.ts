import { describe, it, expect } from "vitest";
import {
  isValidLeaveRange,
  leaveDayCount,
  canCancelLeaveRequest,
  canReviewLeaveRequest,
  leaveRangesOverlap,
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
