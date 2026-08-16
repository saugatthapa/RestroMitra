import { describe, it, expect } from "vitest";
import { isLowStock } from "./inventory";

describe("isLowStock", () => {
  it("is false when no reorder level is configured, regardless of stock", () => {
    expect(isLowStock({ currentStockMilliunits: 0, reorderLevelMilliunits: null })).toBe(false);
    expect(isLowStock({ currentStockMilliunits: -5000, reorderLevelMilliunits: null })).toBe(false);
  });

  it("is true when stock is at or below the reorder level", () => {
    expect(isLowStock({ currentStockMilliunits: 2000, reorderLevelMilliunits: 2000 })).toBe(true);
    expect(isLowStock({ currentStockMilliunits: 1000, reorderLevelMilliunits: 2000 })).toBe(true);
  });

  it("is false when stock is above the reorder level", () => {
    expect(isLowStock({ currentStockMilliunits: 3000, reorderLevelMilliunits: 2000 })).toBe(false);
  });

  it("is true when stock has gone negative and a reorder level is set", () => {
    expect(isLowStock({ currentStockMilliunits: -1000, reorderLevelMilliunits: 0 })).toBe(true);
  });
});
