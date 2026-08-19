import { describe, it, expect } from "vitest";
import {
  createExpenseSchema,
  updateExpenseSchema,
  rejectExpenseSchema,
  payExpenseSchema,
} from "./expenses";

const CATEGORY_ID = "00000000-0000-4000-8000-000000000001";

describe("createExpenseSchema", () => {
  it("accepts a valid expense and converts rupees to paisa", () => {
    const parsed = createExpenseSchema.parse({
      categoryId: CATEGORY_ID,
      amount: 150.5,
      description: "TEST napkins and takeaway boxes",
    });
    expect(parsed.amount).toBe(15050);
    expect(parsed.categoryId).toBe(CATEGORY_ID);
    expect(parsed.expenseDate).toBeUndefined();
  });

  it("rejects a categoryId that isn't a UUID", () => {
    expect(() =>
      createExpenseSchema.parse({
        categoryId: "not-a-uuid",
        amount: 100,
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects a zero or negative amount", () => {
    expect(() =>
      createExpenseSchema.parse({ categoryId: CATEGORY_ID, amount: 0, description: "x" }),
    ).toThrow();
    expect(() =>
      createExpenseSchema.parse({ categoryId: CATEGORY_ID, amount: -50, description: "x" }),
    ).toThrow();
  });

  it("rejects an empty description", () => {
    expect(() =>
      createExpenseSchema.parse({ categoryId: CATEGORY_ID, amount: 100, description: "" }),
    ).toThrow();
  });

  it("accepts a well-formed expenseDate and rejects a malformed one", () => {
    const parsed = createExpenseSchema.parse({
      categoryId: CATEGORY_ID,
      amount: 500,
      description: "TEST electricity",
      expenseDate: "2026-08-01",
    });
    expect(parsed.expenseDate).toBe("2026-08-01");

    expect(() =>
      createExpenseSchema.parse({
        categoryId: CATEGORY_ID,
        amount: 500,
        description: "TEST electricity",
        expenseDate: "08/01/2026",
      }),
    ).toThrow();
  });

  it("rejects a paymentMethod outside the fixed enum", () => {
    expect(() =>
      createExpenseSchema.parse({
        categoryId: CATEGORY_ID,
        amount: 100,
        description: "x",
        paymentMethod: "crypto",
      }),
    ).toThrow();
  });

  it("accepts a valid paymentMethod", () => {
    const parsed = createExpenseSchema.parse({
      categoryId: CATEGORY_ID,
      amount: 100,
      description: "x",
      paymentMethod: "cash",
    });
    expect(parsed.paymentMethod).toBe("cash");
  });
});

describe("updateExpenseSchema", () => {
  it("accepts a partial update", () => {
    const parsed = updateExpenseSchema.parse({ isVoided: true });
    expect(parsed.isVoided).toBe(true);
  });

  it("rejects an empty object (at least one field required)", () => {
    expect(() => updateExpenseSchema.parse({})).toThrow();
  });
});

describe("rejectExpenseSchema", () => {
  it("requires a non-empty reason", () => {
    expect(() => rejectExpenseSchema.parse({ reason: "" })).toThrow();
    const parsed = rejectExpenseSchema.parse({ reason: "Duplicate submission" });
    expect(parsed.reason).toBe("Duplicate submission");
  });
});

describe("payExpenseSchema", () => {
  it("requires a valid payment method", () => {
    expect(() => payExpenseSchema.parse({})).toThrow();
    expect(() => payExpenseSchema.parse({ paymentMethod: "crypto" })).toThrow();
    const parsed = payExpenseSchema.parse({ paymentMethod: "bank_transfer" });
    expect(parsed.paymentMethod).toBe("bank_transfer");
  });
});
