import { test, expect } from "@playwright/test";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import {
  seedOwnerRestaurant,
  seedBranch,
  seedMenuAndTable,
  seedStaffMember,
  teardownRestaurant,
  E2E_PASSWORD,
  type SeededRestaurant,
} from "./db";

/**
 * Gap-audit P1 — multi-branch cross-access denial. Proves out the
 * requireBranchAccess() work in src/lib/rbac/guard.ts through the real UI:
 * a waiter whose own role grant is scoped to Branch A must be denied when
 * trying to view an order that actually belongs to Branch B of the SAME
 * restaurant — not a 500, not a silently-empty page, but the real
 * app-level 403 surfacing as a readable error message (see
 * OrderBillView.tsx's loadError rendering).
 *
 * Two branches, one restaurant, one order placed at each branch via the
 * real public QR flow (so each order's branchId comes from the table it
 * was actually placed at — see /api/order/[token]/route.ts — not a
 * hand-typed column). The Branch-A-scoped staff member can view the
 * Branch A order (positive control — proves the denial below is really
 * about the branch mismatch, not some broader permission gap) but gets
 * turned away from the Branch B order.
 */

let r: SeededRestaurant;
let branchAId: string;
let branchBId: string;
let staffAPhone: string;
let orderAId: string;
let orderBId: string;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("branch-cross-access");
  branchAId = r.branchId; // seedOwnerRestaurant's own "Main" branch
  branchBId = await seedBranch(r, "TEST Branch B");

  const tableA = await seedMenuAndTable(r, { branchId: branchAId });
  const tableB = await seedMenuAndTable(r, { branchId: branchBId });

  const staffA = await seedStaffMember(r, { role: "waiter", branchId: branchAId, fullName: "TEST Branch A Waiter" });
  staffAPhone = staffA.phone;

  // Place one real order at each branch's table via the public QR flow —
  // same mechanism staff-order-management.spec.ts uses, just twice, once
  // per branch's own qrToken. beforeAll has no `page` fixture (that's
  // per-test), so this launches its own short-lived browser purely to walk
  // the public ordering flow as an anonymous guest.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? "3100"}`;
  try {
    const page = await browser.newPage({ baseURL });
    for (const [qrToken, tag] of [
      [tableA.qrToken, "A"],
      [tableB.qrToken, "B"],
    ]) {
      await page.goto(`/order/${qrToken}`);
      await page.getByText("TEST Momo", { exact: true }).click();
      await page.getByRole("button", { name: /add to cart/i }).click();
      await page.getByRole("button", { name: /view cart/i }).click();
      await page.getByRole("button", { name: /checkout/i }).click();
      await page.getByPlaceholder(/your name/i).fill(`TEST Guest ${tag}`);
      await page.getByRole("button", { name: /place order/i }).click();
      await page.waitForSelector("text=/order placed/i");
    }
  } finally {
    await browser.close();
  }

  // Look the two orders' real ids up directly (simplest reliable way to
  // get a UUID out of a flow that only ever shows the human-readable order
  // NUMBER on screen — see staff-order-management.spec.ts's own comment on
  // scraping that from the confirmation screen instead, which this spec
  // doesn't need since it only cares about branch, not order number).
  const branchAOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.restaurantId, r.restaurantId), eq(orders.branchId, branchAId)));
  const branchBOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.restaurantId, r.restaurantId), eq(orders.branchId, branchBId)));
  expect(branchAOrders).toHaveLength(1);
  expect(branchBOrders).toHaveLength(1);
  orderAId = branchAOrders[0].id;
  orderBId = branchBOrders[0].id;
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("staff scoped to Branch A can view their own branch's order but is denied Branch B's", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(staffAPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // Positive control: Branch A's own staff member can open Branch A's
  // order and see real bill data (their total, not an error).
  await page.goto(`/dashboard/orders/${orderAId}`);
  await expect(page.locator("body")).not.toContainText("You do not have access to this branch");
  await expect(page.locator("body")).toContainText(/Rs\.\s*250\.00/);

  // The actual assertion under test: Branch B's order is a different
  // branch of the SAME restaurant — requireBranchAccess must deny it.
  await page.goto(`/dashboard/orders/${orderBId}`);
  await expect(page.locator("body")).toContainText("You do not have access to this branch");
  // And the denial must be a clean, readable error state — not a leak of
  // Branch B's order total, and not a broken/blank page.
  await expect(page.locator("body")).not.toContainText(/Rs\.\s*250\.00/);
  await expect(page.getByRole("link", { name: /back to orders/i })).toBeVisible();
});
