import { describe, it, expect } from "vitest";
import { computeScheduleVariance, pairShiftsWithAttendance, weekRangeContaining, SCHEDULE_GRACE_MINUTES } from "./scheduling";

const start = new Date("2026-08-20T09:00:00Z");
const end = new Date("2026-08-20T17:00:00Z");

describe("computeScheduleVariance", () => {
  it("is 'upcoming' before the shift starts with no attendance yet", () => {
    const now = new Date("2026-08-20T08:00:00Z");
    const result = computeScheduleVariance(start, end, null, now);
    expect(result).toEqual({ status: "upcoming", lateMinutes: 0, earlyDepartureMinutes: 0 });
  });

  it("is 'in_progress' between the shift's start and end with no attendance yet", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    const result = computeScheduleVariance(start, end, null, now);
    expect(result).toEqual({ status: "in_progress", lateMinutes: 0, earlyDepartureMinutes: 0 });
  });

  it("is 'no_show' once the shift has ended with no attendance ever recorded", () => {
    const now = new Date("2026-08-20T18:00:00Z");
    const result = computeScheduleVariance(start, end, null, now);
    expect(result).toEqual({ status: "no_show", lateMinutes: 0, earlyDepartureMinutes: 0 });
  });

  it("clocking in within the grace period counts as on time (0 late minutes)", () => {
    const clockInAt = new Date(start.getTime() + (SCHEDULE_GRACE_MINUTES - 1) * 60_000);
    const result = computeScheduleVariance(start, end, { clockInAt, clockOutAt: null }, new Date());
    expect(result.lateMinutes).toBe(0);
    expect(result.status).toBe("in_progress");
  });

  it("clocking in early counts as on time, never negative late minutes", () => {
    const clockInAt = new Date(start.getTime() - 15 * 60_000);
    const result = computeScheduleVariance(start, end, { clockInAt, clockOutAt: null }, new Date());
    expect(result.lateMinutes).toBe(0);
  });

  it("clocking in past the grace period reports the excess minutes as late", () => {
    const clockInAt = new Date(start.getTime() + 20 * 60_000); // 20 min after planned start
    const result = computeScheduleVariance(start, end, { clockInAt, clockOutAt: null }, new Date());
    expect(result.lateMinutes).toBe(20 - SCHEDULE_GRACE_MINUTES);
    expect(result.status).toBe("in_progress");
  });

  it("is 'completed' with 0 early-departure minutes when clocked out on/after the planned end", () => {
    const clockInAt = start;
    const clockOutAt = new Date(end.getTime() + 10 * 60_000);
    const result = computeScheduleVariance(start, end, { clockInAt, clockOutAt }, new Date());
    expect(result).toEqual({ status: "completed", lateMinutes: 0, earlyDepartureMinutes: 0 });
  });

  it("reports early-departure minutes past the grace period when clocked out early", () => {
    const clockInAt = start;
    const clockOutAt = new Date(end.getTime() - 30 * 60_000); // left 30 min early
    const result = computeScheduleVariance(start, end, { clockInAt, clockOutAt }, new Date());
    expect(result.status).toBe("completed");
    expect(result.earlyDepartureMinutes).toBe(30 - SCHEDULE_GRACE_MINUTES);
  });

  it("a shift can be both late-arriving AND early-leaving at once", () => {
    const clockInAt = new Date(start.getTime() + 25 * 60_000);
    const clockOutAt = new Date(end.getTime() - 40 * 60_000);
    const result = computeScheduleVariance(start, end, { clockInAt, clockOutAt }, new Date());
    expect(result.lateMinutes).toBe(25 - SCHEDULE_GRACE_MINUTES);
    expect(result.earlyDepartureMinutes).toBe(40 - SCHEDULE_GRACE_MINUTES);
  });
});

describe("pairShiftsWithAttendance", () => {
  it("pairs a single shift with its single attendance record", () => {
    const shift = { id: "s1", plannedStartAt: start };
    const attendance = { id: "a1", clockInAt: start };
    const result = pairShiftsWithAttendance([shift], [attendance]);
    expect(result).toEqual([{ shift, attendance }]);
  });

  it("leaves a shift unmatched (null) when there's no attendance at all", () => {
    const shift = { id: "s1", plannedStartAt: start };
    const result = pairShiftsWithAttendance([shift], []);
    expect(result).toEqual([{ shift, attendance: null }]);
  });

  it("pairs multiple shifts with multiple records in chronological order, regardless of input order", () => {
    const shiftEarly = { id: "s-early", plannedStartAt: new Date("2026-08-20T04:00:00Z") };
    const shiftLate = { id: "s-late", plannedStartAt: new Date("2026-08-20T12:00:00Z") };
    const recEarly = { id: "a-early", clockInAt: new Date("2026-08-20T04:05:00Z") };
    const recLate = { id: "a-late", clockInAt: new Date("2026-08-20T12:10:00Z") };

    // Deliberately passed out of order to prove the function sorts, not just zips input order.
    const result = pairShiftsWithAttendance([shiftLate, shiftEarly], [recLate, recEarly]);
    expect(result).toEqual([
      { shift: shiftEarly, attendance: recEarly },
      { shift: shiftLate, attendance: recLate },
    ]);
  });

  it("leaves the extra later shift unmatched when there are more shifts than records", () => {
    const shift1 = { id: "s1", plannedStartAt: new Date("2026-08-20T04:00:00Z") };
    const shift2 = { id: "s2", plannedStartAt: new Date("2026-08-20T12:00:00Z") };
    const rec1 = { id: "a1", clockInAt: new Date("2026-08-20T04:05:00Z") };
    const result = pairShiftsWithAttendance([shift1, shift2], [rec1]);
    expect(result).toEqual([
      { shift: shift1, attendance: rec1 },
      { shift: shift2, attendance: null },
    ]);
  });
});

describe("weekRangeContaining", () => {
  it("a Wednesday's week runs Monday to Sunday", () => {
    // 2026-08-19 is a Wednesday.
    expect(weekRangeContaining("2026-08-19")).toEqual(["2026-08-17", "2026-08-23"]);
  });

  it("a Monday is already the start of its own week", () => {
    expect(weekRangeContaining("2026-08-17")).toEqual(["2026-08-17", "2026-08-23"]);
  });

  it("a Sunday is the end of its own week", () => {
    expect(weekRangeContaining("2026-08-23")).toEqual(["2026-08-17", "2026-08-23"]);
  });

  it("handles a week that spans a month boundary", () => {
    // 2026-08-31 is a Monday.
    expect(weekRangeContaining("2026-08-31")).toEqual(["2026-08-31", "2026-09-06"]);
  });
});
