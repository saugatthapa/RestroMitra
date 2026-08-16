import { describe, it, expect } from "vitest";
import { ASSIGNABLE_STAFF_ROLES, STAFF_ROLE_LABELS } from "./staff-roles";

describe("ASSIGNABLE_STAFF_ROLES", () => {
  it("never includes owner or platform_admin — those aren't reassigned through the staff UI", () => {
    expect(ASSIGNABLE_STAFF_ROLES).not.toContain("owner");
    expect(ASSIGNABLE_STAFF_ROLES).not.toContain("platform_admin");
  });

  it("has a label for every assignable role", () => {
    for (const role of ASSIGNABLE_STAFF_ROLES) {
      expect(STAFF_ROLE_LABELS[role]).toBeTruthy();
    }
  });
});
