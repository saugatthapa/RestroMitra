import { test, expect } from "@playwright/test";
import { seedOwnerRestaurant, seedMenuAndTable, teardownRestaurant, E2E_PASSWORD, type SeededRestaurant } from "./db";

/**
 * Gap-audit P1 — an order placed by a real guest flows through to the
 * Kitchen Display System (KDS) correctly. Places an order through the
 * real public QR flow (same reasoning as staff-order-management.spec.ts:
 * the seam between "a guest placed this" and "it shows up where staff
 * expect it" is exactly what a KDS-visibility regression would break),
 * confirms it from the Orders board, and then checks the SAME ticket shows
 * up on /dashboard/kds — in the right column, with the right item — and
 * can be advanced from there.
 */

let r: SeededRestaurant;
let qrToken: string;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("kds-flow");
  ({ qrToken } = await seedMenuAndTable(r));
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("a confirmed order appears on the KDS board and can be advanced through the kitchen", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

  // 1. Place a real order as an anonymous guest.
  await page.goto(`/order/${qrToken}`);
  await page.getByText("TEST Momo", { exact: true }).click();
  await page.getByRole("button", { name: /add to cart/i }).click();
  await page.getByRole("button", { name: /view cart/i }).click();
  await page.getByRole("button", { name: /checkout/i }).click();
  await page.getByPlaceholder(/your name/i).fill("TEST KDS Guest");
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page.getByText(/order placed/i)).toBeVisible();
  const confirmation = await page.locator("body").innerText();
  const orderNumberMatch = confirmation.match(/Order #\s*([A-Za-z0-9-]+)/);
  expect(orderNumberMatch).not.toBeNull();
  const orderNumber = orderNumberMatch![1];

  // 2. Log in as the owner and confirm the order from the Orders board —
  // KDS only ever shows confirmed/preparing/ready tickets (see
  // KDS_VISIBLE_STATUSES in src/lib/kds.ts), never a still-"pending" one.
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/orders");
  const orderCard = page.locator(`text=#${orderNumber}`).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
  await orderCard.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(`text=#${orderNumber}`)).toBeVisible();

  // 3. The same ticket must now show up on the KDS board, in the
  // "Waiting to start" column (confirmed's KDS label — see COLUMN_LABELS),
  // with the item that was actually ordered.
  await page.goto("/dashboard/kds");
  await expect(page.locator("body")).toContainText("Waiting to start");
  const ticket = page.locator(`a:has-text("#${orderNumber}")`).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
  await expect(ticket).toBeVisible();
  await expect(ticket).toContainText("TEST Momo");

  // 4. Advance it — "Start preparing" (confirmed -> preparing) is the
  // kitchen's own action button (see KITCHEN_ADVANCE in KDSBoard.tsx).
  await ticket.getByRole("button", { name: "Start preparing" }).click();

  // Confirmed the transition actually happened: the ticket is still
  // visible (preparing is still KDS-visible) but its action button has
  // changed to the next stage, "Mark ready" — not silently stuck or gone.
  await expect(ticket.getByRole("button", { name: "Mark ready" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/could not update|failed to update/i);
});
