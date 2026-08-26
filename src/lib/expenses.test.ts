import { describe, it, expect } from "vitest";
import { resolveExpenseDailyCloseCheckDates } from "./expenses";

describe("resolveExpenseDailyCloseCheckDates (Phase 43 QA hardening)", () => {
  it("returns the existing expenseDate when voiding a paid expense", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "paid", expenseDate: "2024-01-15", isVoided: false },
      { isVoided: true },
    );
    expect(dates).toEqual(["2024-01-15"]);
  });

  it("returns the existing expenseDate when un-voiding a paid expense", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "paid", expenseDate: "2024-01-15", isVoided: true },
      { isVoided: false },
    );
    expect(dates).toEqual(["2024-01-15"]);
  });

  it("returns both the old and new expenseDate when retitling a paid expense's date", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "paid", expenseDate: "2024-01-15", isVoided: false },
      { expenseDate: "2024-01-20" },
    );
    expect(dates.sort()).toEqual(["2024-01-15", "2024-01-20"]);
  });

  it("dedupes when both voiding and moving the date land on overlapping days", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "paid", expenseDate: "2024-01-15", isVoided: false },
      { isVoided: true, expenseDate: "2024-01-20" },
    );
    expect(dates.sort()).toEqual(["2024-01-15", "2024-01-20"]);
  });

  it("returns nothing when a pending expense's date is changed (not yet paid)", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "pending", expenseDate: "2024-01-15", isVoided: false },
      { expenseDate: "2024-01-20" },
    );
    expect(dates).toEqual([]);
  });

  it("returns nothing when neither isVoided nor expenseDate is part of the patch", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "paid", expenseDate: "2024-01-15", isVoided: false },
      {},
    );
    expect(dates).toEqual([]);
  });

  it("returns nothing when isVoided is passed but unchanged", () => {
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "paid", expenseDate: "2024-01-15", isVoided: false },
      { isVoided: false },
    );
    expect(dates).toEqual([]);
  });

  it("defensively still returns the existing date if togglingVoid is true on a non-paid expense", () => {
    // The route itself blocks voiding anything but a "paid" expense before
    // this function is ever called, but the function is tested defensively
    // on its own terms since it makes no assumption about that guard.
    const dates = resolveExpenseDailyCloseCheckDates(
      { status: "pending", expenseDate: "2024-01-15", isVoided: false },
      { isVoided: true },
    );
    expect(dates).toEqual(["2024-01-15"]);
  });
});
