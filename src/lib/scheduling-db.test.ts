import { describe, it, expect } from "vitest";
import { matchScheduleWithAttendance } from "./scheduling-db";

const TZ = "Asia/Kathmandu";

describe("matchScheduleWithAttendance", () => {
  it("matches a shift to its attendance record on the same restaurant-local day, computing variance", () => {
    const shift = {
      id: "s1",
      userId: "u1",
      shiftDate: "2026-08-20",
      plannedStartAt: new Date("2026-08-20T03:15:00Z"), // 09:00 Nepal
      plannedEndAt: new Date("2026-08-20T11:15:00Z"), // 17:00 Nepal
    };
    // Clocked in 03:20Z (5 min "late" before grace, so 0 reported) — this
    // instant is still 2026-08-20 in Nepal (03:20Z = 09:05 Nepal).
    const record = {
      id: "a1",
      userId: "u1",
      clockInAt: new Date("2026-08-20T03:20:00Z"),
      clockOutAt: null,
    };

    const [matched] = matchScheduleWithAttendance([shift], [record], TZ, new Date("2026-08-20T05:00:00Z"));
    expect(matched.shift).toBe(shift);
    expect(matched.attendance).toBe(record);
    expect(matched.variance.status).toBe("in_progress");
    expect(matched.variance.lateMinutes).toBe(0); // within grace
  });

  it("does NOT match an attendance record from a different restaurant-local day, even if it's a nearby UTC instant", () => {
    const shift = {
      id: "s1",
      userId: "u1",
      shiftDate: "2026-08-20",
      plannedStartAt: new Date("2026-08-20T03:15:00Z"),
      plannedEndAt: new Date("2026-08-20T11:15:00Z"),
    };
    // 2026-08-19T20:00:00Z = 2026-08-20T01:45 Nepal... wait that's still the
    // 20th. Use an instant that's clearly the 19th in Nepal instead:
    // 2026-08-19T10:00:00Z = 2026-08-19T15:45 Nepal.
    const record = {
      id: "a-prev-day",
      userId: "u1",
      clockInAt: new Date("2026-08-19T10:00:00Z"),
      clockOutAt: null,
    };

    const [matched] = matchScheduleWithAttendance([shift], [record], TZ, new Date("2026-08-20T05:00:00Z"));
    expect(matched.attendance).toBeNull();
    expect(matched.variance.status).toBe("in_progress"); // shift is in its window, nothing matched yet
  });

  it("does NOT match a same-day record from a DIFFERENT user", () => {
    const shift = {
      id: "s1",
      userId: "u1",
      shiftDate: "2026-08-20",
      plannedStartAt: new Date("2026-08-20T03:15:00Z"),
      plannedEndAt: new Date("2026-08-20T11:15:00Z"),
    };
    const record = {
      id: "a-other-user",
      userId: "u2",
      clockInAt: new Date("2026-08-20T03:20:00Z"),
      clockOutAt: null,
    };

    const [matched] = matchScheduleWithAttendance([shift], [record], TZ, new Date("2026-08-20T05:00:00Z"));
    expect(matched.attendance).toBeNull();
  });

  it("reports no_show for a shift whose window has closed with nothing matched", () => {
    const shift = {
      id: "s1",
      userId: "u1",
      shiftDate: "2026-08-20",
      plannedStartAt: new Date("2026-08-20T03:15:00Z"),
      plannedEndAt: new Date("2026-08-20T11:15:00Z"),
    };
    const [matched] = matchScheduleWithAttendance([shift], [], TZ, new Date("2026-08-20T12:00:00Z"));
    expect(matched.variance.status).toBe("no_show");
  });

  it("pairs two same-day shifts for one user with two same-day records, chronologically", () => {
    const morningShift = {
      id: "s-morning",
      userId: "u1",
      shiftDate: "2026-08-20",
      plannedStartAt: new Date("2026-08-20T02:00:00Z"),
      plannedEndAt: new Date("2026-08-20T06:00:00Z"),
    };
    const eveningShift = {
      id: "s-evening",
      userId: "u1",
      shiftDate: "2026-08-20",
      plannedStartAt: new Date("2026-08-20T10:00:00Z"),
      plannedEndAt: new Date("2026-08-20T14:00:00Z"),
    };
    const morningRecord = {
      id: "a-morning",
      userId: "u1",
      clockInAt: new Date("2026-08-20T02:05:00Z"),
      clockOutAt: new Date("2026-08-20T06:05:00Z"),
    };
    const eveningRecord = {
      id: "a-evening",
      userId: "u1",
      clockInAt: new Date("2026-08-20T10:05:00Z"),
      clockOutAt: null,
    };

    const results = matchScheduleWithAttendance(
      [eveningShift, morningShift], // deliberately out of order
      [eveningRecord, morningRecord],
      TZ,
      new Date("2026-08-20T11:00:00Z"),
    );
    expect(results).toHaveLength(2);
    const morningMatch = results.find((r) => r.shift.id === "s-morning");
    const eveningMatch = results.find((r) => r.shift.id === "s-evening");
    expect(morningMatch?.attendance).toBe(morningRecord);
    expect(morningMatch?.variance.status).toBe("completed");
    expect(eveningMatch?.attendance).toBe(eveningRecord);
    expect(eveningMatch?.variance.status).toBe("in_progress");
  });
});
