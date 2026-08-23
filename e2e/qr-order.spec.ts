import { test, expect } from "@playwright/test";
import { seedOwnerRestaurant, seedMenuAndTable, teardownRestaurant, type SeededRestaurant } from "./db";

/**
 * Highest-value flow #2: a guest scanning a table's QR code and placing a
 * real order — no login, the qrToken alone is the access control (see
 * src/app/order/[token]/page.tsx's own doc comment). This is the flow the
 * restaurant's actual revenue depends on, so it's the one most worth
 * protecting from a silent regression.
 */

let r: SeededRestaurant;
let qrToken: string;
let tableName: string;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("qr-order");
  ({ qrToken, tableName } = await seedMenuAndTable(r));
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("guest can browse the menu, add an item, and place an order", async ({ page }) => {
  await page.goto(`/order/${qrToken}`);

  await expect(page.locator("body")).toContainText("TEST E2E qr-order Restaurant");
  await expect(page.locator("body")).toContainText(tableName);

  // Opens the CustomizeModal (the item has no variants/addons, so "Add to
  // cart" is enabled immediately).
  await page.getByText("TEST Momo", { exact: true }).click();
  await page.getByRole("button", { name: /add to cart/i }).click();

  // Floating cart button appears once the cart is non-empty.
  await page.getByRole("button", { name: /view cart/i }).click();
  await expect(page.locator("body")).toContainText("TEST Momo");

  await page.getByRole("button", { name: /checkout/i }).click();
  await page.getByPlaceholder(/your name/i).fill("TEST Guest");
  await page.getByPlaceholder(/phone/i).fill("9812345678");

  await page.getByRole("button", { name: /place order/i }).click();

  // Confirmation screen — the real proof the order round-tripped through
  // POST /api/order/[token] (server-computed pricing, order number
  // assignment) and back, not just that the client-side cart state
  // changed.
  await expect(page.locator("body")).toContainText(/order placed/i);
  await expect(page.locator("body")).toContainText(tableName);
  // Rs. 250.00 — the seeded item's basePriceInPaisa (25000), formatted by
  // formatNPR. No tax configured on the seeded item, so subtotal == total.
  await expect(page.locator("body")).toContainText("250.00");
});
