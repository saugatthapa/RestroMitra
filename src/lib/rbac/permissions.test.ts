import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  DEFAULT_ROLE_PERMISSIONS,
  isReadOnlyPermission,
  roleHasPermission,
} from "./permissions";

describe("permission catalog", () => {
  it("has a description for every permission key", () => {
    for (const key of Object.values(PERMISSIONS)) {
      expect(PERMISSION_DESCRIPTIONS[key]).toBeTruthy();
    }
  });

  it("only grants permissions that exist in the catalog", () => {
    const validKeys = new Set(Object.values(PERMISSIONS));
    for (const keys of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      for (const key of keys) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  it("owner has every permission", () => {
    const ownerPerms = new Set(DEFAULT_ROLE_PERMISSIONS.owner);
    for (const key of Object.values(PERMISSIONS)) {
      expect(ownerPerms.has(key)).toBe(true);
    }
  });

  it("waiter cannot manage staff, edit prices, or view profit", () => {
    const waiterPerms = DEFAULT_ROLE_PERMISSIONS.waiter;
    expect(waiterPerms).not.toContain(PERMISSIONS.MANAGE_STAFF);
    expect(waiterPerms).not.toContain(PERMISSIONS.EDIT_PRICE);
    expect(waiterPerms).not.toContain(PERMISSIONS.VIEW_PROFIT);
  });

  it("kitchen_staff is limited to KDS permissions", () => {
    const kitchenPerms = DEFAULT_ROLE_PERMISSIONS.kitchen_staff;
    expect(kitchenPerms).toEqual(
      expect.arrayContaining([PERMISSIONS.VIEW_KDS, PERMISSIONS.UPDATE_KDS_STATUS]),
    );
    expect(kitchenPerms).not.toContain(PERMISSIONS.MANAGE_INVENTORY);
    expect(kitchenPerms).not.toContain(PERMISSIONS.CREATE_ORDER);
  });

  it("cashier can create/edit orders but not cancel or refund them", () => {
    const cashierPerms = DEFAULT_ROLE_PERMISSIONS.cashier;
    expect(cashierPerms).toContain(PERMISSIONS.CREATE_ORDER);
    expect(cashierPerms).not.toContain(PERMISSIONS.CANCEL_ORDER);
    expect(cashierPerms).not.toContain(PERMISSIONS.REFUND_ORDER);
  });

  it("APPROVE_STOCK_COUNT is withheld from inventory_manager (segregation of duties: the role that usually performs the physical count shouldn't also approve its own large variances)", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.inventory_manager).toContain(PERMISSIONS.MANAGE_INVENTORY);
    expect(DEFAULT_ROLE_PERMISSIONS.inventory_manager).not.toContain(PERMISSIONS.APPROVE_STOCK_COUNT);
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain(PERMISSIONS.APPROVE_STOCK_COUNT);
    expect(DEFAULT_ROLE_PERMISSIONS.accountant).toContain(PERMISSIONS.APPROVE_STOCK_COUNT);
    expect(DEFAULT_ROLE_PERMISSIONS.cashier).not.toContain(PERMISSIONS.APPROVE_STOCK_COUNT);
    expect(DEFAULT_ROLE_PERMISSIONS.waiter).not.toContain(PERMISSIONS.APPROVE_STOCK_COUNT);
  });
});

describe("impersonation permission model (Phase 8)", () => {
  it("isReadOnlyPermission is true for every view_* permission and false for everything else", () => {
    for (const key of Object.values(PERMISSIONS)) {
      expect(isReadOnlyPermission(key)).toBe(key.startsWith("view_"));
    }
    // Spot checks so this test still fails loudly if the naming convention
    // itself ever drifts (e.g. someone adds a "view_" mutation by mistake).
    expect(isReadOnlyPermission(PERMISSIONS.VIEW_SALES)).toBe(true);
    expect(isReadOnlyPermission(PERMISSIONS.VIEW_REPORTS)).toBe(true);
    expect(isReadOnlyPermission(PERMISSIONS.CREATE_ORDER)).toBe(false);
    expect(isReadOnlyPermission(PERMISSIONS.MANAGE_STAFF)).toBe(false);
    expect(isReadOnlyPermission(PERMISSIONS.REFUND_ORDER)).toBe(false);
  });

  it("impersonated_write behaves exactly like owner/platform_admin — a full bypass of the permission matrix", () => {
    for (const key of Object.values(PERMISSIONS)) {
      expect(roleHasPermission("impersonated_write", key)).toBe(true);
    }
  });

  it("impersonated_read is granted every view_* permission and denied every mutation", () => {
    for (const key of Object.values(PERMISSIONS)) {
      expect(roleHasPermission("impersonated_read", key)).toBe(key.startsWith("view_"));
    }
    expect(roleHasPermission("impersonated_read", PERMISSIONS.VIEW_SALES)).toBe(true);
    expect(roleHasPermission("impersonated_read", PERMISSIONS.CREATE_ORDER)).toBe(false);
    expect(roleHasPermission("impersonated_read", PERMISSIONS.MANAGE_STAFF)).toBe(false);
    expect(roleHasPermission("impersonated_read", PERMISSIONS.CANCEL_ORDER)).toBe(false);
  });

  it("impersonated_read is never accidentally satisfied by DEFAULT_ROLE_PERMISSIONS (it must never fall through to the table lookup)", () => {
    // "impersonated_read"/"impersonated_write" are pseudo-roles, never a
    // real staff role stored in the DB — they must be handled by the two
    // explicit branches above roleHasPermission's table lookup, never by
    // accidentally matching a real DEFAULT_ROLE_PERMISSIONS key.
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS)).not.toContain("impersonated_read");
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS)).not.toContain("impersonated_write");
  });
});
