import { describe, it, expect } from "vitest";
import { addStaffSchema, updateStaffSchema } from "./staff";

describe("addStaffSchema", () => {
  it("accepts a valid phone + role, with fullName/password optional", () => {
    const parsed = addStaffSchema.parse({ phone: "9812345678", role: "waiter" });
    expect(parsed.phone).toBe("9812345678");
    expect(parsed.role).toBe("waiter");
    expect(parsed.fullName).toBeUndefined();
  });

  it("rejects an invalid Nepal phone number", () => {
    expect(() => addStaffSchema.parse({ phone: "12345", role: "waiter" })).toThrow();
    expect(() => addStaffSchema.parse({ phone: "8812345678", role: "waiter" })).toThrow(); // wrong prefix
  });

  it("rejects a role outside the assignable set (e.g. owner, platform_admin)", () => {
    expect(() => addStaffSchema.parse({ phone: "9812345678", role: "owner" })).toThrow();
    expect(() => addStaffSchema.parse({ phone: "9812345678", role: "platform_admin" })).toThrow();
  });

  it("rejects a too-short password when provided", () => {
    expect(() =>
      addStaffSchema.parse({ phone: "9812345678", role: "waiter", password: "short" }),
    ).toThrow();
  });
});

describe("updateStaffSchema", () => {
  it("accepts a role-only change", () => {
    const parsed = updateStaffSchema.parse({ role: "manager" });
    expect(parsed.role).toBe("manager");
    expect(parsed.isActive).toBeUndefined();
  });

  it("accepts an isActive-only change", () => {
    const parsed = updateStaffSchema.parse({ isActive: false });
    expect(parsed.isActive).toBe(false);
  });

  it("rejects an empty object (neither field provided)", () => {
    expect(() => updateStaffSchema.parse({})).toThrow();
  });
});
