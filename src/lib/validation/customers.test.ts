import { describe, it, expect } from "vitest";
import { createCustomerSchema, updateCustomerSchema, adjustLoyaltySchema } from "./customers";

describe("createCustomerSchema", () => {
  it("accepts a valid phone + full name, email/notes optional", () => {
    const parsed = createCustomerSchema.parse({ phone: "9812345678", fullName: "Hari Bahadur" });
    expect(parsed.phone).toBe("9812345678");
    expect(parsed.fullName).toBe("Hari Bahadur");
  });

  it("rejects an invalid Nepal phone number", () => {
    expect(() => createCustomerSchema.parse({ phone: "12345", fullName: "Test" })).toThrow();
    expect(() =>
      createCustomerSchema.parse({ phone: "8812345678", fullName: "Test" }),
    ).toThrow(); // wrong prefix
  });

  it("rejects a too-short full name", () => {
    expect(() => createCustomerSchema.parse({ phone: "9812345678", fullName: "H" })).toThrow();
  });

  it("rejects an invalid email when provided", () => {
    expect(() =>
      createCustomerSchema.parse({ phone: "9812345678", fullName: "Test", email: "not-an-email" }),
    ).toThrow();
  });

  it("accepts an empty-string email (treated as not provided)", () => {
    const parsed = createCustomerSchema.parse({
      phone: "9812345678",
      fullName: "Test",
      email: "",
    });
    expect(parsed.email).toBe("");
  });
});

describe("updateCustomerSchema", () => {
  it("accepts a partial update", () => {
    const parsed = updateCustomerSchema.parse({ isActive: false });
    expect(parsed.isActive).toBe(false);
  });

  it("accepts an empty object (all fields optional)", () => {
    expect(() => updateCustomerSchema.parse({})).not.toThrow();
  });
});

describe("adjustLoyaltySchema", () => {
  it("accepts a valid add adjustment", () => {
    const parsed = adjustLoyaltySchema.parse({ points: 100, direction: "add", reason: "Goodwill" });
    expect(parsed.points).toBe(100);
    expect(parsed.direction).toBe("add");
  });

  it("rejects a zero or negative point value", () => {
    expect(() =>
      adjustLoyaltySchema.parse({ points: 0, direction: "add", reason: "x" }),
    ).toThrow();
    expect(() =>
      adjustLoyaltySchema.parse({ points: -5, direction: "add", reason: "x" }),
    ).toThrow();
  });

  it("rejects a non-integer point value", () => {
    expect(() =>
      adjustLoyaltySchema.parse({ points: 1.5, direction: "add", reason: "x" }),
    ).toThrow();
  });

  it("requires a non-empty reason", () => {
    expect(() =>
      adjustLoyaltySchema.parse({ points: 10, direction: "redeem", reason: "" }),
    ).toThrow();
  });

  it("rejects a direction outside add/redeem", () => {
    expect(() =>
      adjustLoyaltySchema.parse({ points: 10, direction: "subtract", reason: "x" }),
    ).toThrow();
  });
});
