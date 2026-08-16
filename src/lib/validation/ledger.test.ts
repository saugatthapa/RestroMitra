import { describe, it, expect } from "vitest";
import { createLedgerEntrySchema, settleLedgerDueSchema } from "./ledger";

describe("createLedgerEntrySchema", () => {
  it("accepts a minimal valid credit entry", () => {
    const parsed = createLedgerEntrySchema.parse({
      direction: "credit",
      category: "sales",
      amount: 500,
      description: "Cash sale",
    });
    expect(parsed.amount).toBe(50000); // paisa
    expect(parsed.direction).toBe("credit");
  });

  it("rejects due_settlement as a manual category", () => {
    expect(() =>
      createLedgerEntrySchema.parse({
        direction: "credit",
        category: "due_settlement",
        amount: 100,
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects a direction outside credit/debit", () => {
    expect(() =>
      createLedgerEntrySchema.parse({
        direction: "neutral",
        category: "other",
        amount: 100,
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects a zero or negative amount", () => {
    expect(() =>
      createLedgerEntrySchema.parse({
        direction: "debit",
        category: "expense",
        amount: 0,
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects an empty description", () => {
    expect(() =>
      createLedgerEntrySchema.parse({
        direction: "debit",
        category: "expense",
        amount: 100,
        description: "",
      }),
    ).toThrow();
  });

  it("accepts markAsDue and counterpartyName", () => {
    const parsed = createLedgerEntrySchema.parse({
      direction: "credit",
      category: "sales",
      amount: 200,
      description: "Catering order",
      counterpartyName: "Hari Bahadur",
      markAsDue: true,
    });
    expect(parsed.markAsDue).toBe(true);
    expect(parsed.counterpartyName).toBe("Hari Bahadur");
  });

  it("rejects a malformed entryDate", () => {
    expect(() =>
      createLedgerEntrySchema.parse({
        direction: "debit",
        category: "expense",
        amount: 100,
        description: "x",
        entryDate: "16-08-2026",
      }),
    ).toThrow();
  });
});

describe("settleLedgerDueSchema", () => {
  it("accepts a valid settlement amount", () => {
    const parsed = settleLedgerDueSchema.parse({ amount: 150 });
    expect(parsed.amount).toBe(15000);
  });

  it("rejects a zero or negative settlement amount", () => {
    expect(() => settleLedgerDueSchema.parse({ amount: 0 })).toThrow();
    expect(() => settleLedgerDueSchema.parse({ amount: -10 })).toThrow();
  });
});
