import { describe, it, expect } from "vitest";
import { orderAdjustmentsInputSchema, resolveOrderAdjustmentsInput } from "./order-adjustments";

describe("orderAdjustmentsInputSchema", () => {
  it("accepts an empty body (no discount, no service charge)", () => {
    const result = orderAdjustmentsInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a percentage discount with discountPercent set", () => {
    const result = orderAdjustmentsInputSchema.safeParse({
      discountType: "percentage",
      discountPercent: 10,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a flat discount with discountFlatAmount set", () => {
    const result = orderAdjustmentsInputSchema.safeParse({
      discountType: "flat",
      discountFlatAmount: 200,
    });
    expect(result.success).toBe(true);
  });

  it("rejects percentage discountType with discountFlatAmount instead of discountPercent", () => {
    const result = orderAdjustmentsInputSchema.safeParse({
      discountType: "percentage",
      discountFlatAmount: 200,
    });
    expect(result.success).toBe(false);
  });

  it("rejects flat discountType with discountPercent instead of discountFlatAmount", () => {
    const result = orderAdjustmentsInputSchema.safeParse({
      discountType: "flat",
      discountPercent: 10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects percentage discountType with BOTH values present", () => {
    const result = orderAdjustmentsInputSchema.safeParse({
      discountType: "percentage",
      discountPercent: 10,
      discountFlatAmount: 200,
    });
    expect(result.success).toBe(false);
  });

  it("rejects no discountType but a discountPercent/discountFlatAmount present", () => {
    expect(orderAdjustmentsInputSchema.safeParse({ discountPercent: 10 }).success).toBe(false);
    expect(orderAdjustmentsInputSchema.safeParse({ discountFlatAmount: 100 }).success).toBe(false);
  });

  it("rejects a discountPercent outside 0-100", () => {
    expect(
      orderAdjustmentsInputSchema.safeParse({ discountType: "percentage", discountPercent: -5 })
        .success,
    ).toBe(false);
    expect(
      orderAdjustmentsInputSchema.safeParse({ discountType: "percentage", discountPercent: 150 })
        .success,
    ).toBe(false);
  });

  it("rejects a negative serviceChargePercent", () => {
    expect(orderAdjustmentsInputSchema.safeParse({ serviceChargePercent: -1 }).success).toBe(false);
  });

  it("accepts a service charge with no discount", () => {
    const result = orderAdjustmentsInputSchema.safeParse({ serviceChargePercent: 10 });
    expect(result.success).toBe(true);
  });

  it("defaults serviceChargePercent to 0 when omitted", () => {
    const result = orderAdjustmentsInputSchema.parse({});
    expect(result.serviceChargePercent).toBe(0);
  });
});

describe("resolveOrderAdjustmentsInput", () => {
  it("resolves a percentage discount to basis points", () => {
    const resolved = resolveOrderAdjustmentsInput({
      discountType: "percentage",
      discountPercent: 12.5,
      serviceChargePercent: 0,
    });
    expect(resolved.discountType).toBe("percentage");
    expect(resolved.discountValue).toBe(1_250); // 12.5% -> 1250 bps
  });

  it("resolves a flat discount (rupees) to paisa", () => {
    const resolved = resolveOrderAdjustmentsInput({
      discountType: "flat",
      discountFlatAmount: 150,
      serviceChargePercent: 0,
    });
    expect(resolved.discountType).toBe("flat");
    expect(resolved.discountValue).toBe(15_000); // Rs 150 -> 15,000 paisa
  });

  it("resolves no discount to null type and null value", () => {
    const resolved = resolveOrderAdjustmentsInput({ serviceChargePercent: 0 });
    expect(resolved.discountType).toBeNull();
    expect(resolved.discountValue).toBeNull();
  });

  it("resolves serviceChargePercent to basis points", () => {
    const resolved = resolveOrderAdjustmentsInput({ serviceChargePercent: 10 });
    expect(resolved.serviceChargeBasisPoints).toBe(1_000);
  });

  it("trims discountReason and converts empty string to null", () => {
    const withReason = resolveOrderAdjustmentsInput({
      discountType: "percentage",
      discountPercent: 10,
      discountReason: "  Loyal customer  ",
      serviceChargePercent: 0,
    });
    expect(withReason.discountReason).toBe("Loyal customer");

    const emptyReason = resolveOrderAdjustmentsInput({
      discountType: "percentage",
      discountPercent: 10,
      discountReason: "",
      serviceChargePercent: 0,
    });
    expect(emptyReason.discountReason).toBeNull();
  });

  it("nulls out discountReason when there's no discount at all, even if one was sent", () => {
    const resolved = resolveOrderAdjustmentsInput({
      discountReason: "Should be ignored",
      serviceChargePercent: 0,
    });
    expect(resolved.discountReason).toBeNull();
  });
});
