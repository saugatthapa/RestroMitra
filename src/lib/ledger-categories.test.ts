import { describe, it, expect } from "vitest";
import {
  LEDGER_CATEGORIES,
  LEDGER_CATEGORY_LABELS,
  LEDGER_DIRECTIONS,
  LEDGER_DIRECTION_LABELS,
  MANUAL_LEDGER_CATEGORIES,
} from "./ledger-categories";

describe("ledger-categories", () => {
  it("has a label for every category", () => {
    for (const category of LEDGER_CATEGORIES) {
      expect(LEDGER_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it("has a label for every direction", () => {
    for (const direction of LEDGER_DIRECTIONS) {
      expect(LEDGER_DIRECTION_LABELS[direction]).toBeTruthy();
    }
  });

  it("excludes due_settlement from the manual-entry category list", () => {
    expect(MANUAL_LEDGER_CATEGORIES).not.toContain("due_settlement");
  });

  it("keeps every other category available for manual entries", () => {
    const nonSettlement = LEDGER_CATEGORIES.filter((c) => c !== "due_settlement");
    expect(MANUAL_LEDGER_CATEGORIES.sort()).toEqual(nonSettlement.sort());
  });
});
