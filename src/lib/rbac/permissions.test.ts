import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  DEFAULT_ROLE_PERMISSIONS,
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
