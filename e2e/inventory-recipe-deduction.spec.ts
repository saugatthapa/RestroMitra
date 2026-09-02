import { test, expect } from "@playwright/test";
import {
  seedOwnerRestaurant,
  seedMenuAndTable,
  seedInventoryItemWithRecipe,
  teardownRestaurant,
  E2E_PASSWORD,
  type SeededRestaurant,
} from "./db";

/**
 * Gap-audit P1 — inventory -> recipe -> deduction. Placing a real order for
 * a recipe-linked menu item and advancing it to "preparing" (the one point
 * in the order lifecycle where deductRecipeStockForOrder actually runs —
 * see the status route's own comment) must visibly deduct the linked
 * ingredient's stock, exactly as shown on the Inventory > Items tab a
 * manager would actually look at.
 *
 * "TEST Momo" is linked to one recipe ingredient, "TEST Chicken (raw)":
 * 200g consumed per serving, starting stock 2000g. Ordering one serving
 * and advancing it to preparing should leave exactly 1800g.
 */

let r: SeededRestaurant;
let qrToken: string;

const STARTING_STOCK_G = 2000;
const PER_SERVING_G = 200;
const EXPECTED_REMAINING_G = STARTING_STOCK_G - PER_SERVING_G;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("inventory-recipe");
  const menu = await seedMenuAndTable(r);
  qrToken = menu.qrToken;
  await seedInventoryItemWithRecipe(r, {
    menuItemId: menu.menuItemId,
    name: "TEST Chicken (raw)",
    unit: "g",
    initialStockMilliunits: STARTING_STOCK_G * 1000,
    quantityPerServingMilliunits: PER_SERVING_G * 1000,
  });
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("confirming and starting a recipe-linked order deducts the exact ingredient quantity", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

  // 1. Place one real order for the recipe-linked item as an anonymous guest.
  await page.goto(`/order/${qrToken}`);
  await page.getByText("TEST Momo", { exact: true }).click();
  await page.getByRole("button", { name: /add to cart/i }).click();
  await page.getByRole("button", { name: /view cart/i }).click();
  await page.getByRole("button", { name: /checkout/i }).click();
  await page.getByPlaceholder(/your name/i).fill("TEST Inventory Guest");
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page.getByText(/order placed/i)).toBeVisible();
  const confirmation = await page.locator("body").innerText();
  const orderNumberMatch = confirmation.match(/Order #\s*([A-Za-z0-9-]+)/);
  expect(orderNumberMatch).not.toBeNull();
  const orderNumber = orderNumberMatch![1];

  // 2. Log in as the owner.
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // 3. Before anything is confirmed, the ingredient's stock must still
  // read the full starting amount — the deduction must not fire early
  // (e.g. at order placement time, before the kitchen even accepts it).
  await page.goto("/dashboard/inventory");
  await expect(page.locator("body")).toContainText(`${STARTING_STOCK_G} g`);

  // 4. Confirm the order (pending -> confirmed): still no deduction —
  // confirmed -> preparing is the one specific transition that deducts
  // stock (see deductRecipeStockForOrder's call site in the status route).
  await page.goto("/dashboard/orders");
  const orderCard = page.locator(`text=#${orderNumber}`).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
  await orderCard.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(`text=#${orderNumber}`)).toBeVisible();

  await page.goto("/dashboard/inventory");
  await expect(page.locator("body")).toContainText(`${STARTING_STOCK_G} g`);

  // 5. Start preparing it from the KDS board — this is the transition
  // that actually deducts stock.
  await page.goto("/dashboard/kds");
  const ticket = page.locator(`a:has-text("#${orderNumber}")`).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
  await ticket.getByRole("button", { name: "Start preparing" }).click();
  await expect(ticket.getByRole("button", { name: "Mark ready" })).toBeVisible();

  // 6. Back on the Items tab, the ingredient's stock must now read exactly
  // starting minus one serving's worth — the concrete, UI-visible proof of
  // the deduction, not just an API-level assertion.
  await page.goto("/dashboard/inventory");
  await expect(page.locator("body")).toContainText(`${EXPECTED_REMAINING_G} g`);
  await expect(page.locator("body")).not.toContainText(`${STARTING_STOCK_G} g`);
});
