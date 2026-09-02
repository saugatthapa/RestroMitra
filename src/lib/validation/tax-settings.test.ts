import { describe, it, expect } from "vitest";
import { updateTaxSettingsSchema } from "./tax-settings";

describe("updateTaxSettingsSchema", () => {
  it("accepts both fields set", () => {
    const parsed = updateTaxSettingsSchema.parse({
      panNumber: "123456789",
      vatNumber: "987654321",
    });
    expect(parsed.panNumber).toBe("123456789");
    expect(parsed.vatNumber).toBe("987654321");
  });

  it("accepts either field alone (most restaurants have no VAT number)", () => {
    const panOnly = updateTaxSettingsSchema.parse({ panNumber: "123456789", vatNumber: "" });
    expect(panOnly.panNumber).toBe("123456789");
    expect(panOnly.vatNumber).toBe("");
  });

  it("accepts both fields omitted entirely", () => {
    const parsed = updateTaxSettingsSchema.parse({});
    expect(parsed.panNumber).toBeUndefined();
    expect(parsed.vatNumber).toBeUndefined();
  });

  it("accepts an empty string for either field (the route's own convention for clearing it back to null)", () => {
    const parsed = updateTaxSettingsSchema.parse({ panNumber: "", vatNumber: "" });
    expect(parsed.panNumber).toBe("");
    expect(parsed.vatNumber).toBe("");
  });

  it("trims surrounding whitespace", () => {
    const parsed = updateTaxSettingsSchema.parse({ panNumber: "  123456789  " });
    expect(parsed.panNumber).toBe("123456789");
  });

  it("rejects a panNumber longer than 20 characters", () => {
    expect(() =>
      updateTaxSettingsSchema.parse({ panNumber: "1".repeat(21) }),
    ).toThrow();
  });

  it("rejects a vatNumber longer than 20 characters", () => {
    expect(() =>
      updateTaxSettingsSchema.parse({ vatNumber: "1".repeat(21) }),
    ).toThrow();
  });
});
