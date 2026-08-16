import { describe, it, expect } from "vitest";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from "./expense-categories";

describe("EXPENSE_CATEGORIES", () => {
  it("has a label for every category", () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(EXPENSE_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it("includes 'other' as a catch-all", () => {
    expect(EXPENSE_CATEGORIES).toContain("other");
  });

  it("has no duplicate categories", () => {
    expect(new Set(EXPENSE_CATEGORIES).size).toBe(EXPENSE_CATEGORIES.length);
  });
});
