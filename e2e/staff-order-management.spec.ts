import { test, expect } from "@playwright/test";
import {
  seedOwnerRestaurant,
  seedMenuAndTable,
  teardownRestaurant,
  E2E_PASSWORD,
  type SeededRestaurant,
} from "./db";

/**
 * Highest-value flow #3: an order a guest just placed through the public
 * QR page actually shows up on staff's Orders board, and staff can advance
 * it. Deliberately places the order through the real public flow (not a
 * direct DB insert) rather than testing the two flows in isolation — the
 * seam between "an anonymous guest submitted this" and "staff, scoped to
 * this restaurant/branch, can see and act on it" is exactly the kind of
 * thing a branch-scoping or permissions regression could break silently
 * (see this session's P0-7 branch-scoped push-notification fix for a real
 * example of that seam breaking).
 */

let r: SeededRestaurant;
let qrToken: string;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("staff-orders");
  ({ qrToken } = await seedMenuAndTable(r));
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("an order placed via QR appears on staff's board and can be confirmed", async ({ page }) => {
  // OrdersBoard's updateStatus() falls back to a native alert() for a real
  // API error (permission denied, validation, a genuine 409) — surface
  // that as a hard test failure with the actual server message instead of
  // Playwright silently auto-dismissing it, which would otherwise look
  // like the click just did nothing.
  page.on("dialog", (dialog) => {
    const message = dialog.message();
    dialog.dismiss().catch(() => {});
    if (!/cancel order/i.test(message)) {
      throw new Error(`Unexpected dialog while confirming order: ${message}`);
    }
  });

  // 1. Place a real order as an anonymous guest.
  await page.goto(`/order/${qrToken}`);
  await page.getByText("TEST Momo", { exact: true }).click();
  await page.getByRole("button", { name: /add to cart/i }).click();
  await page.getByRole("button", { name: /view cart/i }).click();
  await page.getByRole("button", { name: /checkout/i }).click();
  await page.getByPlaceholder(/your name/i).fill("TEST Guest");
  await page.getByRole("button", { name: /place order/i }).click();

  // The confirmation screen only replaces the checkout form once
  // POST /api/order/[token] resolves and CheckoutView's onPlaced() runs
  // (see PublicOrderMenu.tsx) — click() itself only waits for the click,
  // not for that async round trip, so an explicit wait here (rather than
  // reading body text immediately) is required to not race it.
  await expect(page.getByText(/order placed/i)).toBeVisible();
  const confirmation = await page.locator("body").innerText();
  const orderNumberMatch = confirmation.match(/Order #\s*([A-Za-z0-9-]+)/);
  expect(orderNumberMatch, "confirmation screen should show an order number").not.toBeNull();
  const orderNumber = orderNumberMatch![1];

  // 2. Switch to staff: log in as the seeded owner and open the Orders board.
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/orders");

  const orderCard = page.locator(`text=#${orderNumber}`).first();
  await expect(orderCard).toBeVisible();

  // 3. Advance it: a freshly-placed order is "pending", and OrdersBoard
  // labels the pending→confirmed action "Confirm" (see ADVANCE_LABELS in
  // OrdersBoard.tsx).
  const card = page.locator(`text=#${orderNumber}`).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
  await card.getByRole("button", { name: "Confirm" }).click();

  // Confirming moves the card out of the Pending column and into
  // Confirmed — the order number should still be visible on the board
  // (now under a different status), not disappear or error out.
  await expect(page.locator(`text=#${orderNumber}`)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/failed to update|could not update/i);
});
