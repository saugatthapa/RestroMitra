import { describe, it, expect } from "vitest";
import { updateServiceCallSchema } from "./service-calls";

describe("updateServiceCallSchema", () => {
  it("accepts acknowledge and resolve", () => {
    expect(updateServiceCallSchema.safeParse({ action: "acknowledge" }).success).toBe(true);
    expect(updateServiceCallSchema.safeParse({ action: "resolve" }).success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(updateServiceCallSchema.safeParse({ action: "delete" }).success).toBe(false);
    expect(updateServiceCallSchema.safeParse({}).success).toBe(false);
    expect(updateServiceCallSchema.safeParse({ action: "" }).success).toBe(false);
  });
});
