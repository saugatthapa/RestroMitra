import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "./db-error";

describe("isUniqueViolation", () => {
  it("recognizes a top-level err.code (raw postgres.js error, not wrapped)", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("recognizes err.cause.code (drizzle-orm's DrizzleQueryError wrapping, from inside db.transaction)", () => {
    expect(isUniqueViolation({ message: "Failed query", cause: { code: "23505" } })).toBe(true);
  });

  it("returns false for an unrelated Postgres error code", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
  });

  it("returns false for non-error-shaped values", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
    expect(isUniqueViolation(new Error("plain error, no code"))).toBe(false);
  });
});
