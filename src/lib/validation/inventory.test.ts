import { describe, it, expect } from "vitest";
import {
  createInventoryItemSchema,
  createPurchaseSchema,
  recordStockAdjustmentSchema,
  replaceRecipeSchema,
} from "./inventory";

describe("createInventoryItemSchema", () => {
  it("converts reorderLevel from real units to milliunits-ready output (still real units — route converts)", () => {
    const parsed = createInventoryItemSchema.parse({ name: "Chicken", unit: "kg", reorderLevel: 2.5 });
    // reorderLevel is NOT auto-transformed by the schema (see the route's
    // manual unitsToMilliunits call) — this test pins that contract so a
    // future edit doesn't silently start double-converting it.
    expect(parsed.reorderLevel).toBe(2.5);
  });

  it("allows a null reorder level (no alerting)", () => {
    const parsed = createInventoryItemSchema.parse({ name: "Chicken", unit: "kg", reorderLevel: null });
    expect(parsed.reorderLevel).toBeNull();
  });

  it("rejects an empty name", () => {
    expect(() => createInventoryItemSchema.parse({ name: "", unit: "kg" })).toThrow();
  });

  it("rejects an invalid unit", () => {
    expect(() =>
      createInventoryItemSchema.parse({ name: "Chicken", unit: "lbs" as unknown as "kg" }),
    ).toThrow();
  });
});

describe("recordStockAdjustmentSchema", () => {
  it("converts quantity from real units to milliunits", () => {
    const parsed = recordStockAdjustmentSchema.parse({
      branchId: "00000000-0000-0000-0000-000000000000",
      quantity: 2.5,
      direction: "add",
      reason: "count",
    });
    expect(parsed.quantity).toBe(2500);
  });

  it("rejects a zero or negative quantity", () => {
    expect(() =>
      recordStockAdjustmentSchema.parse({ quantity: 0, direction: "add", reason: "x" }),
    ).toThrow();
    expect(() =>
      recordStockAdjustmentSchema.parse({ quantity: -1, direction: "add", reason: "x" }),
    ).toThrow();
  });

  it("requires a non-empty reason", () => {
    expect(() =>
      recordStockAdjustmentSchema.parse({ quantity: 1, direction: "add", reason: "" }),
    ).toThrow();
  });
});

describe("createPurchaseSchema", () => {
  it("converts quantity to milliunits and unitCost to paisa per line", () => {
    const parsed = createPurchaseSchema.parse({
      branchId: "00000000-0000-0000-0000-000000000000",
      items: [{ inventoryItemId: "00000000-0000-0000-0000-000000000000", quantity: 2, unitCost: 150.5 }],
    });
    expect(parsed.items[0].quantity).toBe(2000);
    expect(parsed.items[0].unitCost).toBe(15050);
  });

  it("requires at least one line item", () => {
    expect(() => createPurchaseSchema.parse({ items: [] })).toThrow();
  });
});

describe("replaceRecipeSchema", () => {
  it("converts quantityPerServing to milliunits", () => {
    const parsed = replaceRecipeSchema.parse({
      items: [{ inventoryItemId: "00000000-0000-0000-0000-000000000000", quantityPerServing: 0.25 }],
    });
    expect(parsed.items[0].quantityPerServing).toBe(250);
  });

  it("defaults to an empty ingredient list", () => {
    const parsed = replaceRecipeSchema.parse({});
    expect(parsed.items).toEqual([]);
  });

  it("rejects the same ingredient listed twice", () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect(() =>
      replaceRecipeSchema.parse({
        items: [
          { inventoryItemId: id, quantityPerServing: 0.1 },
          { inventoryItemId: id, quantityPerServing: 0.2 },
        ],
      }),
    ).toThrow();
  });
});
