import { describe, it, expect } from "vitest";
import { adminSubscriptionActionSchema, adminTenantSuspensionSchema } from "./subscription";

describe("adminSubscriptionActionSchema", () => {
  it("accepts every action variant with its minimal required fields", () => {
    const cases = [
      { action: "extend_trial", days: 14 },
      { action: "shorten_trial", days: 7 },
      { action: "assign_plan", planKey: "growth", activate: true },
      { action: "mark_past_due" },
      { action: "pause" },
      { action: "cancel" },
      { action: "reactivate" },
    ];
    for (const input of cases) {
      expect(adminSubscriptionActionSchema.safeParse(input).success).toBe(true);
    }
  });

  it("shorten_trial rejects a day count outside [1, 365]", () => {
    expect(adminSubscriptionActionSchema.safeParse({ action: "shorten_trial", days: 0 }).success).toBe(false);
    expect(adminSubscriptionActionSchema.safeParse({ action: "shorten_trial", days: 366 }).success).toBe(false);
    expect(adminSubscriptionActionSchema.safeParse({ action: "shorten_trial", days: 1 }).success).toBe(true);
    expect(adminSubscriptionActionSchema.safeParse({ action: "shorten_trial", days: 365 }).success).toBe(true);
  });

  it("shorten_trial requires days (can't shorten by an unspecified amount)", () => {
    expect(adminSubscriptionActionSchema.safeParse({ action: "shorten_trial" }).success).toBe(false);
  });

  it("pause accepts an optional note but doesn't require one", () => {
    expect(adminSubscriptionActionSchema.safeParse({ action: "pause" }).success).toBe(true);
    expect(adminSubscriptionActionSchema.safeParse({ action: "pause", note: "Owner requested" }).success).toBe(
      true,
    );
  });

  it("rejects an unrecognized action", () => {
    expect(adminSubscriptionActionSchema.safeParse({ action: "delete_forever" }).success).toBe(false);
  });

  it("rejects a variant's fields bleeding into the wrong action (e.g. planKey on pause)", () => {
    // The discriminated union means Zod resolves by `action` first, then
    // validates only that branch's shape — a stray extra field on the
    // wrong branch should be stripped/ignored, not cause cross-branch
    // validation, so this documents that pause still succeeds even with
    // an unrelated field present.
    const result = adminSubscriptionActionSchema.safeParse({ action: "pause", planKey: "growth" });
    expect(result.success).toBe(true);
  });
});

describe("adminTenantSuspensionSchema", () => {
  it("requires a reason of at least 3 characters", () => {
    expect(adminTenantSuspensionSchema.safeParse({ action: "suspend", reason: "ab" }).success).toBe(false);
    expect(adminTenantSuspensionSchema.safeParse({ action: "suspend", reason: "" }).success).toBe(false);
    expect(adminTenantSuspensionSchema.safeParse({ action: "suspend" }).success).toBe(false);
    expect(adminTenantSuspensionSchema.safeParse({ action: "suspend", reason: "Fraud investigation" }).success).toBe(
      true,
    );
  });

  it("only accepts 'suspend' or 'reactivate' as the action", () => {
    expect(adminTenantSuspensionSchema.safeParse({ action: "pause", reason: "abc" }).success).toBe(false);
    expect(adminTenantSuspensionSchema.safeParse({ action: "reactivate", reason: "Resolved" }).success).toBe(true);
  });
});
