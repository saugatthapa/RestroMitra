import { describe, it, expect } from "vitest";
import {
  restaurantDate,
  restaurantHour,
  restaurantStartOfDay,
  restaurantEndOfDay,
  restaurantWallClockToUtc,
  restaurantTimeOfDay,
} from "./restaurant-date";

describe("restaurantDate", () => {
  it("returns the Nepal calendar day for a UTC instant that's still 'today' in UTC too", () => {
    // 2026-08-15 10:00 UTC = 2026-08-15 15:45 Nepal — same day either way.
    expect(restaurantDate("Asia/Kathmandu", new Date("2026-08-15T10:00:00Z"))).toBe("2026-08-15");
  });

  it("returns the Nepal calendar day for a UTC instant that's already 'tomorrow' in Nepal — the actual bug this fixes", () => {
    // 2026-08-14 19:00 UTC = 2026-08-15 00:45 Nepal (UTC+5:45) — UTC still
    // says the 14th; Nepal has already crossed into the 15th. The old
    // `new Date().toISOString().slice(0,10)` code would have said "14".
    expect(restaurantDate("Asia/Kathmandu", new Date("2026-08-14T19:00:00Z"))).toBe("2026-08-15");
  });

  it("just before Nepal midnight is still the earlier day", () => {
    // 2026-08-14 18:00 UTC = 2026-08-14 23:45 Nepal.
    expect(restaurantDate("Asia/Kathmandu", new Date("2026-08-14T18:00:00Z"))).toBe("2026-08-14");
  });

  it("falls back to Asia/Kathmandu for null/undefined/empty timezone", () => {
    const at = new Date("2026-08-14T19:00:00Z");
    expect(restaurantDate(null, at)).toBe("2026-08-15");
    expect(restaurantDate(undefined, at)).toBe("2026-08-15");
    expect(restaurantDate("", at)).toBe("2026-08-15");
  });

  it("respects a different IANA zone (product expansion beyond Nepal)", () => {
    // 2026-08-14 23:30 UTC is still 2026-08-14 in New York (UTC-4 in August).
    expect(restaurantDate("America/New_York", new Date("2026-08-14T23:30:00Z"))).toBe("2026-08-14");
    // The same instant is already 2026-08-15 in Kathmandu.
    expect(restaurantDate("Asia/Kathmandu", new Date("2026-08-14T23:30:00Z"))).toBe("2026-08-15");
  });
});

describe("restaurantHour", () => {
  it("returns the local hour, not the UTC hour", () => {
    // 18:00 UTC = 23:45 Nepal -> hour 23.
    expect(restaurantHour("Asia/Kathmandu", new Date("2026-08-14T18:00:00Z"))).toBe(23);
    // 19:00 UTC = 00:45 Nepal (next day) -> hour 0, not 24.
    expect(restaurantHour("Asia/Kathmandu", new Date("2026-08-14T19:00:00Z"))).toBe(0);
  });
});

describe("restaurantStartOfDay / restaurantEndOfDay", () => {
  it("start of day round-trips back to the same local date via restaurantDate", () => {
    const start = restaurantStartOfDay("Asia/Kathmandu", "2026-08-15");
    expect(restaurantDate("Asia/Kathmandu", start)).toBe("2026-08-15");
  });

  it("start of day is exactly local midnight — Nepal is UTC+5:45, so it's 18:15 UTC the PREVIOUS day", () => {
    const start = restaurantStartOfDay("Asia/Kathmandu", "2026-08-15");
    expect(start.toISOString()).toBe("2026-08-14T18:15:00.000Z");
  });

  it("end of day is 1ms before the next day's start", () => {
    const end = restaurantEndOfDay("Asia/Kathmandu", "2026-08-15");
    const nextStart = restaurantStartOfDay("Asia/Kathmandu", "2026-08-16");
    expect(end.getTime()).toBe(nextStart.getTime() - 1);
    expect(restaurantDate("Asia/Kathmandu", end)).toBe("2026-08-15");
  });

  it("defaults to today in the given timezone when no dateStr is passed", () => {
    const now = new Date();
    const start = restaurantStartOfDay("Asia/Kathmandu");
    expect(restaurantDate("Asia/Kathmandu", start)).toBe(restaurantDate("Asia/Kathmandu", now));
  });
});

describe("restaurantWallClockToUtc", () => {
  it("converts a Nepal wall-clock time to the matching UTC instant — 9:00 AM Nepal is 03:15 UTC same day", () => {
    const at = restaurantWallClockToUtc("Asia/Kathmandu", "2026-08-15", "09:00");
    expect(at.toISOString()).toBe("2026-08-15T03:15:00.000Z");
  });

  it("round-trips back to the same local date/hour via restaurantDate/restaurantHour", () => {
    const at = restaurantWallClockToUtc("Asia/Kathmandu", "2026-08-15", "22:30");
    expect(restaurantDate("Asia/Kathmandu", at)).toBe("2026-08-15");
    expect(restaurantHour("Asia/Kathmandu", at)).toBe(22);
  });

  it("a late-night wall-clock time still lands on the requested calendar date, not the UTC date it crosses into", () => {
    // 23:30 Nepal on the 15th is already 17:45 UTC the SAME day here (Nepal
    // is ahead of UTC), but the function must still report the 15th when
    // asked, regardless of which side of a UTC day boundary that instant falls.
    const at = restaurantWallClockToUtc("Asia/Kathmandu", "2026-08-15", "23:30");
    expect(restaurantDate("Asia/Kathmandu", at)).toBe("2026-08-15");
  });

  it("falls back to Asia/Kathmandu for null/undefined/empty timezone", () => {
    const withNull = restaurantWallClockToUtc(null, "2026-08-15", "09:00");
    const withKathmandu = restaurantWallClockToUtc("Asia/Kathmandu", "2026-08-15", "09:00");
    expect(withNull.getTime()).toBe(withKathmandu.getTime());
  });

  it("respects a different IANA zone (product expansion beyond Nepal)", () => {
    // 9:00 AM in New York (UTC-4 in August) is 13:00 UTC.
    const at = restaurantWallClockToUtc("America/New_York", "2026-08-15", "09:00");
    expect(at.toISOString()).toBe("2026-08-15T13:00:00.000Z");
  });
});

describe("restaurantTimeOfDay", () => {
  it("is the inverse of restaurantWallClockToUtc — round-trips back to the same HH:MM", () => {
    const at = restaurantWallClockToUtc("Asia/Kathmandu", "2026-08-15", "09:00");
    expect(restaurantTimeOfDay("Asia/Kathmandu", at)).toBe("09:00");
  });

  it("returns the LOCAL time-of-day, never the instant's raw UTC hour/minute — the actual bug this prevents", () => {
    // 03:15 UTC is 09:00 in Nepal (UTC+5:45) — reading the UTC hour/minute
    // directly here (03:15) instead of converting would silently shift a
    // rescheduled shift by the timezone offset.
    const at = new Date("2026-08-15T03:15:00Z");
    expect(restaurantTimeOfDay("Asia/Kathmandu", at)).toBe("09:00");
  });

  it("pads single-digit hour and minute", () => {
    const at = restaurantWallClockToUtc("Asia/Kathmandu", "2026-08-15", "05:05");
    expect(restaurantTimeOfDay("Asia/Kathmandu", at)).toBe("05:05");
  });
});
