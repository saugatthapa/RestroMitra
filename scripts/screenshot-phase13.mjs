// Phase 13: screenshot check for the POS discount/service-charge panel and
// the order bill-view's adjustments panel + tip display, using the
// pre-seeded test restaurant/manager/order from setup-screenshot-phase13.sh
// which must run immediately before this script. Logs in through the real
// UI form (same pattern as screenshot-phase12.mjs) since the session cookie
// is signed/scoped in ways curl's jar doesn't roundtrip cleanly into
// Playwright.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot13_phone.txt", "utf8").trim();
const orderId = readFileSync("/tmp/screenshot13_order_id.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });

// --- POS: discount/service-charge panel -------------------------------------
await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
// Add an item to the cart so the checkout panel (with the discount section)
// is populated and the estimated-total preview has real numbers.
const firstItem = page.locator("button:has-text('TEST Phase13 Screenshot Combo')").first();
if (await firstItem.count()) {
  await firstItem.click();
  await page.waitForTimeout(300);
  const addButton = page.locator('button:has-text("Add to order")');
  if (await addButton.count()) {
    await addButton.click();
    await page.waitForTimeout(300);
  }
}
// Select percentage discount and fill values so the preview breakdown shows.
const pctButton = page.locator('button:has-text("% off")').first();
if (await pctButton.count()) {
  await pctButton.click();
  await page.fill('input[placeholder="Discount %"]', "10");
  await page.fill('input[placeholder="Service charge % (optional)"]', "10");
  await page.waitForTimeout(200);
}
await page.screenshot({ path: "/tmp/pos-discount-panel.png", fullPage: true });
console.log("saved /tmp/pos-discount-panel.png");

// --- Order bill view: discount/service-charge/tip display + adjustments panel
await page.goto(`${BASE}/dashboard/orders/${orderId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/order-bill-view.png", fullPage: true });
console.log("saved /tmp/order-bill-view.png");

const editAdjustments = page.locator('button:has-text("Edit discount / service charge")');
if (await editAdjustments.count()) {
  await editAdjustments.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/order-bill-adjustments-panel.png", fullPage: true });
  console.log("saved /tmp/order-bill-adjustments-panel.png");
} else {
  console.log("WARNING: adjustments panel toggle button not found");
}

await context.close();
await browser.close();
console.log("done");
