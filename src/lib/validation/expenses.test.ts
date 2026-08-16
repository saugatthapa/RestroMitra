import { describe, it, expect } from "vitest";
import { createExpenseSchema, updateExpenseSchema } from "./expenses";

describe("createExpenseSchema", () => {
  it("accepts a valid expense and converts rupees to paisa", () => {
    const parsed = createExpenseSchema.parse({
      category: "supplies",
      amount: 150.5,
      description: "TEST napkins and takeaway boxes",
    });
    expect(parsed.amount).toBe(15050);
    expect(parsed.category).toBe("supplies");
    expect(parsed.expenseDate).toBeUndefined();
  });

  it("rejects a category outside the fixed enum", () => {
    expect(() =>
      createExpenseSchema.parse({
        category: "bribes",
        amount: 100,
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects a zero or negative amount", () => {
    expect(() =>
      createExpenseSchema.parse({ category: "rent", amount: 0, description: "x" }),
    ).toThrow();
    expect(() =>
      createExpenseSchema.parse({ category: "rent", amount: -50, description: "x" }),
    ).toThrow();
  });

  it("rejects an empty description", () => {
    expect(() =>
      createExpenseSchema.parse({ category: "rent", amount: 100, description: "" }),
    ).toThrow();
  });

  it("accepts a well-formed expenseDate and rejects a malformed one", () => {
    const parsed = createExpenseSchema.parse({
      category: "utilities",
      amount: 500,
      description: "TEST electricity",
      expenseDate: "2026-08-01",
    });
    expect(parsed.expenseDate).toBe("2026-08-01");

    expect(() =>
      createExpenseSchema.parse({
        category: "utilities",
        amount: 500,
        description: "TEST electricity",
        expenseDate: "08/01/2026",
      }),
    ).toThrow();
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
