import { describe, it, expect } from "vitest";
import { isOpenShift, computeDurationMinutes, formatDuration, totalMinutes } from "./attendance";

describe("isOpenShift", () => {
  it("is true when clockOutAt is null", () => {
    expect(isOpenShift({ clockInAt: new Date(), clockOutAt: null })).toBe(true);
  });

  it("is false once clockOutAt is set", () => {
    expect(isOpenShift({ clockInAt: new Date(), clockOutAt: new Date() })).toBe(false);
  });
});

describe("computeDurationMinutes", () => {
  it("computes minutes between clock-in and clock-out", () => {
    const clockInAt = new Date("2026-08-14T09:00:00Z");
    const clockOutAt = new Date("2026-08-14T17:30:00Z");
    expect(computeDurationMinutes({ clockInAt, clockOutAt })).toBe(510); // 8h30m
  });

  it("computes minutes up to `now` for an open shift", () => {
    const clockInAt = new Date("2026-08-14T09:00:00Z");
    const now = new Date("2026-08-14T11:00:00Z");
    expect(computeDurationMinutes({ clockInAt, clockOutAt: null }, now)).toBe(120);
  });

  it("never returns a negative duration even with a clock skew edge case", () => {
    const clockInAt = new Date("2026-08-14T11:00:00Z");
    const now = new Date("2026-08-14T09:00:00Z"); // now "before" clock-in
    expect(computeDurationMinutes({ clockInAt, clockOutAt: null }, now)).toBe(0);
  });

  it("accepts ISO string timestamps, not just Date objects (matches JSON API responses)", () => {
    expect(
      computeDurationMinutes({
        clockInAt: "2026-08-14T09:00:00Z",
        clockOutAt: "2026-08-14T10:15:00Z",
      }),
    ).toBe(75);
  });
});

describe("formatDuration", () => {
  it("formats under an hour as just minutes", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(0)).toBe("0m");
  });

  it("formats an hour or more as Xh Ym", () => {
    expect(formatDuration(510)).toBe("8h 30m");
    expect(formatDuration(60)).toBe("1h 0m");
  });
});

describe("totalMinutes", () => {
  it("sums durations across multiple records, including an open shift up to `now`", () => {
    const now = new Date("2026-08-14T12:00:00Z");
    const records = [
      { clockInAt: "2026-08-13T09:00:00Z", clockOutAt: "2026-08-13T17:00:00Z" }, // 480
      { clockInAt: "2026-08-14T09:00:00Z", clockOutAt: null }, // 180 up to `now`
    ];
    expect(totalMinutes(records, now)).toBe(660);
  });

  it("returns 0 for an empty list", () => {
    expect(totalMinutes([])).toBe(0);
  });
});
