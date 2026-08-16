import { describe, it, expect } from "vitest";
import { isBirthdayToday, shouldAwardBirthdayBonus } from "./loyalty-birthday";

describe("isBirthdayToday", () => {
  it("matches on month+day regardless of birth year", () => {
    expect(isBirthdayToday("1998-08-16", "2026-08-16")).toBe(true);
    expect(isBirthdayToday("1965-08-16", "2026-08-16")).toBe(true);
  });

  it("is false when the month or day differs", () => {
    expect(isBirthdayToday("1998-08-17", "2026-08-16")).toBe(false);
    expect(isBirthdayToday("1998-09-16", "2026-08-16")).toBe(false);
  });

  it("is false when no date of birth is on file", () => {
    expect(isBirthdayToday(null, "2026-08-16")).toBe(false);
  });
});

describe("shouldAwardBirthdayBonus", () => {
  it("awards on their birthday when not yet awarded this year", () => {
    expect(
      shouldAwardBirthdayBonus({
        dateOfBirth: "1998-08-16",
        lastBirthdayBonusYear: null,
        todayIso: "2026-08-16",
      }),
    ).toBe(true);
  });

  it("awards again this birthday even if a prior year's bonus was recorded", () => {
    expect(
      shouldAwardBirthdayBonus({
        dateOfBirth: "1998-08-16",
        lastBirthdayBonusYear: 2025,
        todayIso: "2026-08-16",
      }),
    ).toBe(true);
  });

  it("does not award twice in the same year", () => {
    expect(
      shouldAwardBirthdayBonus({
        dateOfBirth: "1998-08-16",
        lastBirthdayBonusYear: 2026,
        todayIso: "2026-08-16",
      }),
    ).toBe(false);
  });

  it("does not award on a non-birthday", () => {
    expect(
      shouldAwardBirthdayBonus({
        dateOfBirth: "1998-08-17",
        lastBirthdayBonusYear: null,
        todayIso: "2026-08-16",
      }),
    ).toBe(false);
  });

  it("does not award when no date of birth is on file", () => {
    expect(
      shouldAwardBirthdayBonus({
        dateOfBirth: null,
        lastBirthdayBonusYear: null,
        todayIso: "2026-08-16",
      }),
    ).toBe(false);
  });
});
