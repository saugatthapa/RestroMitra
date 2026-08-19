import { describe, it, expect } from "vitest";
import { DEFAULT_EXPENSE_CATEGORY_NAMES } from "./expense-categories";

describe("DEFAULT_EXPENSE_CATEGORY_NAMES", () => {
  it("includes 'Miscellaneous' as a catch-all", () => {
    expect(DEFAULT_EXPENSE_CATEGORY_NAMES).toContain("Miscellaneous");
  });

  it("has no duplicate categories", () => {
    expect(new Set(DEFAULT_EXPENSE_CATEGORY_NAMES).size).toBe(DEFAULT_EXPENSE_CATEGORY_NAMES.length);
  });

  it("has no empty names", () => {
    for (const name of DEFAULT_EXPENSE_CATEGORY_NAMES) {
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });
});
