import { describe, it, expect } from "vitest";
import { localDateIso, firstOfMonthIso } from "./local-date";

describe("localDateIso", () => {
  it("formats a date's own local year/month/day, not its UTC ones", () => {
    // A local time deep enough into the evening that UTC would already be
    // on the next day for any timezone west of UTC+something small — the
    // exact scenario this function exists to get right (see its own doc
    // comment's Nepal/UTC+5:45 example).
    const d = new Date(2024, 2, 5); // local: 2024-03-05 (month is 0-indexed)
    expect(localDateIso(d)).toBe("2024-03-05");
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date(2024, 0, 9); // local: 2024-01-09
    expect(localDateIso(d)).toBe("2024-01-09");
  });

  it("defaults to the current date when called with no argument", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(localDateIso()).toBe(expected);
  });
});

describe("firstOfMonthIso (QA hardening — shared home for a duplicated helper)", () => {
  it("returns day 01 of the given date's local month", () => {
    const d = new Date(2024, 2, 17); // local: 2024-03-17
    expect(firstOfMonthIso(d)).toBe("2024-03-01");
  });

  it("zero-pads single-digit months", () => {
    const d = new Date(2024, 0, 28); // local: 2024-01-28
    expect(firstOfMonthIso(d)).toBe("2024-01-01");
  });

  it("is unaffected by the day-of-month component", () => {
    const first = new Date(2024, 5, 1);
    const last = new Date(2024, 5, 30);
    expect(firstOfMonthIso(first)).toBe(firstOfMonthIso(last));
  });

  it("defaults to the current month when called with no argument", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    expect(firstOfMonthIso()).toBe(expected);
  });
});
