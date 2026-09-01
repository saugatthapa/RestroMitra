import { describe, it, expect } from "vitest";
import {
  computeStaffAttendanceAnalytics,
  emptyStaffAttendanceAnalytics,
  isDateWithinLeaveRanges,
  isDateHoliday,
} from "./attendance-analytics";

const localDate = (d: Date) => d.toISOString().slice(0, 10);

describe("emptyStaffAttendanceAnalytics", () => {
  it("returns all zeros for the given userId", () => {
    expect(emptyStaffAttendanceAnalytics("u1")).toEqual({
      userId: "u1",
      totalMinutes: 0,
      daysPresent: 0,
      rejectedShiftsCount: 0,
      paidLeaveDays: 0,
      scheduledShiftsCount: 0,
      completedShiftsCount: 0,
      noShowCount: 0,
      lateCount: 0,
      totalLateMinutes: 0,
      totalEarlyDepartureMinutes: 0,
      excusedLeaveCount: 0,
      excusedHolidayCount: 0,
    });
  });
});

describe("computeStaffAttendanceAnalytics", () => {
  it("returns all zeros for a staff member with no records, no shifts, and no leave", () => {
    const result = computeStaffAttendanceAnalytics("u1", [], [], 0, localDate);
    expect(result).toEqual(emptyStaffAttendanceAnalytics("u1"));
  });

  it("excludes rejected records from totalMinutes/daysPresent but counts them in rejectedShiftsCount", () => {
    const records = [
      { clockInAt: "2026-08-01T09:00:00Z", clockOutAt: "2026-08-01T17:00:00Z", status: "verified" as const },
      { clockInAt: "2026-08-02T09:00:00Z", clockOutAt: "2026-08-02T17:00:00Z", status: "rejected" as const },
      { clockInAt: "2026-08-03T09:00:00Z", clockOutAt: "2026-08-03T17:00:00Z", status: "needs_review" as const },
    ];
    const result = computeStaffAttendanceAnalytics("u1", records, [], 0, localDate);
    expect(result.daysPresent).toBe(2); // only the two non-rejected days
    expect(result.totalMinutes).toBe(960); // 2 * 8h
    expect(result.rejectedShiftsCount).toBe(1);
  });

  it("passes paidLeaveDays through untouched", () => {
    const result = computeStaffAttendanceAnalytics("u1", [], [], 3, localDate);
    expect(result.paidLeaveDays).toBe(3);
  });

  it("tallies scheduledShiftsCount, completedShiftsCount, and noShowCount from matched-shift statuses", () => {
    const matchedShifts = [
      { variance: { status: "completed" as const, lateMinutes: 0, earlyDepartureMinutes: 0 } },
      { variance: { status: "completed" as const, lateMinutes: 20, earlyDepartureMinutes: 0 } },
      { variance: { status: "no_show" as const, lateMinutes: 0, earlyDepartureMinutes: 0 } },
      { variance: { status: "upcoming" as const, lateMinutes: 0, earlyDepartureMinutes: 0 } },
    ];
    const result = computeStaffAttendanceAnalytics("u1", [], matchedShifts, 0, localDate);
    expect(result.scheduledShiftsCount).toBe(4);
    expect(result.completedShiftsCount).toBe(2);
    expect(result.noShowCount).toBe(1);
  });

  it("counts lateCount only for shifts with lateMinutes > 0, and sums totalLateMinutes/totalEarlyDepartureMinutes across all matched shifts", () => {
    const matchedShifts = [
      { variance: { status: "completed" as const, lateMinutes: 15, earlyDepartureMinutes: 10 } },
      { variance: { status: "completed" as const, lateMinutes: 0, earlyDepartureMinutes: 5 } },
      { variance: { status: "completed" as const, lateMinutes: 30, earlyDepartureMinutes: 0 } },
    ];
    const result = computeStaffAttendanceAnalytics("u1", [], matchedShifts, 0, localDate);
    expect(result.lateCount).toBe(2); // the two with lateMinutes > 0
    expect(result.totalLateMinutes).toBe(45); // 15 + 30
    expect(result.totalEarlyDepartureMinutes).toBe(15); // 10 + 5
  });

  it("combines attendance, leave, and scheduling figures independently in one call", () => {
    const records = [
      { clockInAt: "2026-08-01T09:00:00Z", clockOutAt: "2026-08-01T13:00:00Z", status: "verified" as const },
    ];
    const matchedShifts = [{ variance: { status: "completed" as const, lateMinutes: 10, earlyDepartureMinutes: 0 } }];
    const result = computeStaffAttendanceAnalytics("u1", records, matchedShifts, 2, localDate);
    expect(result).toEqual({
      userId: "u1",
      totalMinutes: 240,
      daysPresent: 1,
      rejectedShiftsCount: 0,
      paidLeaveDays: 2,
      scheduledShiftsCount: 1,
      completedShiftsCount: 1,
      noShowCount: 0,
      lateCount: 1,
      totalLateMinutes: 10,
      totalEarlyDepartureMinutes: 0,
      excusedLeaveCount: 0,
      excusedHolidayCount: 0,
    });
  });

  it("excludes a matched shift from noShowCount/lateCount when excusedReason is 'leave' — approved leave means no obligation to show up", () => {
    const matchedShifts = [
      { variance: { status: "no_show" as const, lateMinutes: 0, earlyDepartureMinutes: 0 }, excusedReason: "leave" as const },
      { variance: { status: "no_show" as const, lateMinutes: 0, earlyDepartureMinutes: 0 } }, // a genuine, unexcused no-show
    ];
    const result = computeStaffAttendanceAnalytics("u1", [], matchedShifts, 0, localDate);
    expect(result.scheduledShiftsCount).toBe(2); // still counted as scheduled
    expect(result.noShowCount).toBe(1); // only the unexcused one
    expect(result.excusedLeaveCount).toBe(1);
    expect(result.excusedHolidayCount).toBe(0);
  });

  it("excludes a matched shift from noShowCount/lateCount when excusedReason is 'holiday' — a branch closure means no obligation to show up", () => {
    const matchedShifts = [
      {
        variance: { status: "completed" as const, lateMinutes: 25, earlyDepartureMinutes: 0 },
        excusedReason: "holiday" as const,
      },
    ];
    const result = computeStaffAttendanceAnalytics("u1", [], matchedShifts, 0, localDate);
    expect(result.lateCount).toBe(0); // would have been late, but excused
    expect(result.totalLateMinutes).toBe(0);
    expect(result.excusedHolidayCount).toBe(1);
    expect(result.excusedLeaveCount).toBe(0);
    // still counts toward completedShiftsCount — they DID show up despite the holiday.
    expect(result.completedShiftsCount).toBe(1);
  });
});

describe("isDateWithinLeaveRanges", () => {
  it("returns true when the date falls within an inclusive leave range", () => {
    expect(isDateWithinLeaveRanges("2026-09-02", [{ startDate: "2026-09-01", endDate: "2026-09-03" }])).toBe(true);
    expect(isDateWithinLeaveRanges("2026-09-01", [{ startDate: "2026-09-01", endDate: "2026-09-01" }])).toBe(true);
    expect(isDateWithinLeaveRanges("2026-09-03", [{ startDate: "2026-09-01", endDate: "2026-09-03" }])).toBe(true);
  });

  it("returns false when the date is outside every range, and for an empty list", () => {
    expect(isDateWithinLeaveRanges("2026-09-04", [{ startDate: "2026-09-01", endDate: "2026-09-03" }])).toBe(false);
    expect(isDateWithinLeaveRanges("2026-09-01", [])).toBe(false);
  });
});

describe("isDateHoliday", () => {
  it("matches a restaurant-wide holiday regardless of the shift's branch", () => {
    const restaurantWide = new Set(["2026-10-20"]);
    const byBranch = new Map<string, ReadonlySet<string>>();
    expect(isDateHoliday("2026-10-20", "branch-a", restaurantWide, byBranch)).toBe(true);
    expect(isDateHoliday("2026-10-20", null, restaurantWide, byBranch)).toBe(true);
  });

  it("matches a branch-specific holiday only for a shift at that branch, not an unscoped shift or a different branch", () => {
    const restaurantWide = new Set<string>();
    const byBranch = new Map<string, ReadonlySet<string>>([["branch-a", new Set(["2026-10-21"])]]);
    expect(isDateHoliday("2026-10-21", "branch-a", restaurantWide, byBranch)).toBe(true);
    expect(isDateHoliday("2026-10-21", "branch-b", restaurantWide, byBranch)).toBe(false);
    expect(isDateHoliday("2026-10-21", null, restaurantWide, byBranch)).toBe(false);
  });

  it("returns false for a date with no holiday declared", () => {
    expect(isDateHoliday("2026-10-22", "branch-a", new Set(), new Map())).toBe(false);
  });
});
