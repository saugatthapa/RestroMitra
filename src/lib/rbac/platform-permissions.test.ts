import { describe, it, expect } from "vitest";
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_DESCRIPTIONS,
  PLATFORM_DEFAULT_ROLE_PERMISSIONS,
  PLATFORM_ROLES,
  isPlatformRole,
  roleHasPlatformPermission,
} from "./platform-permissions";

describe("platform permission catalog", () => {
  it("has a description for every permission key", () => {
    for (const key of Object.values(PLATFORM_PERMISSIONS)) {
      expect(PLATFORM_PERMISSION_DESCRIPTIONS[key]).toBeTruthy();
    }
  });

  it("only grants permissions that exist in the catalog", () => {
    const validKeys = new Set(Object.values(PLATFORM_PERMISSIONS));
    for (const keys of Object.values(PLATFORM_DEFAULT_ROLE_PERMISSIONS)) {
      for (const key of keys) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  it("isPlatformRole recognizes all five platform roles and rejects tenant roles", () => {
    for (const role of PLATFORM_ROLES) {
      expect(isPlatformRole(role)).toBe(true);
    }
    expect(isPlatformRole("owner")).toBe(false);
    expect(isPlatformRole("manager")).toBe(false);
    expect(isPlatformRole("")).toBe(false);
  });

  describe("roleHasPlatformPermission", () => {
    it("platform_admin and super_admin bypass the entire matrix", () => {
      for (const role of ["platform_admin", "super_admin"]) {
        for (const permission of Object.values(PLATFORM_PERMISSIONS)) {
          expect(roleHasPlatformPermission(role, permission)).toBe(true);
        }
      }
    });

    it("support_admin gets support-tier permissions, not billing/entitlement ones", () => {
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(true);
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.IMPERSONATE_TENANT)).toBe(true);
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.VIEW_TENANTS)).toBe(true);
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.MANAGE_SUBSCRIPTIONS)).toBe(false);
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.MANAGE_PLANS)).toBe(false);
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS)).toBe(false);
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS)).toBe(false);
    });

    it("billing_admin gets subscription/plan permissions, not support/impersonation", () => {
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.MANAGE_SUBSCRIPTIONS)).toBe(true);
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.MANAGE_PLANS)).toBe(true);
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.VIEW_TENANTS)).toBe(true);
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.IMPERSONATE_TENANT)).toBe(false);
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(false);
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS)).toBe(false);
    });

    it("platform_viewer is read-only", () => {
      expect(roleHasPlatformPermission("platform_viewer", PLATFORM_PERMISSIONS.VIEW_TENANTS)).toBe(true);
      expect(roleHasPlatformPermission("platform_viewer", PLATFORM_PERMISSIONS.VIEW_PLATFORM_AUDIT_LOG)).toBe(true);
      expect(roleHasPlatformPermission("platform_viewer", PLATFORM_PERMISSIONS.MANAGE_TENANTS)).toBe(false);
      expect(roleHasPlatformPermission("platform_viewer", PLATFORM_PERMISSIONS.MANAGE_SUBSCRIPTIONS)).toBe(false);
      expect(roleHasPlatformPermission("platform_viewer", PLATFORM_PERMISSIONS.IMPERSONATE_TENANT)).toBe(false);
    });

    it("no narrow role holds MANAGE_PLATFORM_ADMINS — self-escalation is impossible from any of them", () => {
      for (const role of ["support_admin", "billing_admin", "platform_viewer"]) {
        expect(roleHasPlatformPermission(role, PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS)).toBe(false);
      }
    });

    it("a plain tenant role (e.g. owner) or an unknown string grants nothing in this catalog", () => {
      expect(roleHasPlatformPermission("owner", PLATFORM_PERMISSIONS.VIEW_TENANTS)).toBe(false);
      expect(roleHasPlatformPermission("manager", PLATFORM_PERMISSIONS.VIEW_TENANTS)).toBe(false);
      expect(roleHasPlatformPermission("not_a_real_role", PLATFORM_PERMISSIONS.VIEW_TENANTS)).toBe(false);
    });
  });
});
