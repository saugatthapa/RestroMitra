import { describe, it, expect } from "vitest";
import { restaurantDate, restaurantHour, restaurantStartOfDay, restaurantEndOfDay } from "./restaurant-date";

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
