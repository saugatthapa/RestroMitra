import { describe, it, expect } from "vitest";
import {
  deriveTableStatus,
  canManuallyTransition,
  manualNextStatuses,
  TABLE_STATUSES,
} from "./table-status";

describe("deriveTableStatus", () => {
  it("returns 'available' when there is no order activity at all", () => {
    expect(deriveTableStatus({ kitchenActive: 0, served: 0, completed: 0 })).toBe("available");
  });

  it("returns 'occupied' whenever any order is still kitchen-active, regardless of the other buckets", () => {
    expect(deriveTableStatus({ kitchenActive: 1, served: 0, completed: 0 })).toBe("occupied");
    expect(deriveTableStatus({ kitchenActive: 1, served: 3, completed: 5 })).toBe("occupied");
  });

  it("returns 'payment_pending' when nothing is kitchen-active but something is served", () => {
    expect(deriveTableStatus({ kitchenActive: 0, served: 1, completed: 0 })).toBe("payment_pending");
    expect(deriveTableStatus({ kitchenActive: 0, served: 2, completed: 4 })).toBe("payment_pending");
  });

  it("returns 'cleaning' when everything outstanding is completed and nothing is served/active", () => {
    expect(deriveTableStatus({ kitchenActive: 0, served: 0, completed: 1 })).toBe("cleaning");
  });

  it("prioritizes kitchenActive over served over completed (a table with a mix of order states)", () => {
    // e.g. dessert ordered after mains: one order already completed/paid,
    // a second one still preparing — the table is very much still occupied.
    expect(deriveTableStatus({ kitchenActive: 1, served: 1, completed: 1 })).toBe("occupied");
    expect(deriveTableStatus({ kitchenActive: 0, served: 1, completed: 1 })).toBe("payment_pending");
  });

  it("treats a cancelled-only table (all buckets zero) as available — releases the table", () => {
    // cancelled orders are deliberately excluded from all three buckets by
    // the caller (syncTableStatusFromOrders), so this is the natural
    // "nothing real happened here" case.
    expect(deriveTableStatus({ kitchenActive: 0, served: 0, completed: 0 })).toBe("available");
  });
});

describe("canManuallyTransition", () => {
  it("allows staff to open a table for ordering from available or reserved", () => {
    expect(canManuallyTransition("available", "ordering")).toBe(true);
    expect(canManuallyTransition("reserved", "ordering")).toBe(true);
  });

  it("allows backing out of 'ordering' without submitting an order", () => {
    expect(canManuallyTransition("ordering", "available")).toBe(true);
  });

  it("allows marking any status out_of_service, and restoring only to available", () => {
    for (const from of TABLE_STATUSES) {
      if (from === "out_of_service") continue;
      expect(canManuallyTransition(from, "out_of_service")).toBe(true);
    }
    expect(canManuallyTransition("out_of_service", "available")).toBe(true);
  });

  it("allows staff to finish cleaning", () => {
    expect(canManuallyTransition("cleaning", "available")).toBe(true);
  });

  it("rejects manually faking a system-derived status", () => {
    // occupied/payment_pending/reserved (from an available table) are only
    // ever reachable through order/reservation activity, never a direct
    // manual PATCH — otherwise the two mechanisms could fight each other.
    expect(canManuallyTransition("available", "occupied")).toBe(false);
    expect(canManuallyTransition("available", "payment_pending")).toBe(false);
    expect(canManuallyTransition("available", "reserved")).toBe(false);
    expect(canManuallyTransition("ordering", "occupied")).toBe(false);
    expect(canManuallyTransition("cleaning", "payment_pending")).toBe(false);
  });

  it("rejects transitions out of occupied/payment_pending other than to out_of_service", () => {
    expect(canManuallyTransition("occupied", "available")).toBe(false);
    expect(canManuallyTransition("occupied", "cleaning")).toBe(false);
    expect(canManuallyTransition("payment_pending", "cleaning")).toBe(false);
  });
});

describe("manualNextStatuses", () => {
  it("agrees with canManuallyTransition for every status pair", () => {
    for (const from of TABLE_STATUSES) {
      for (const to of TABLE_STATUSES) {
        expect(manualNextStatuses(from).includes(to)).toBe(canManuallyTransition(from, to));
      }
    }
  });
});
