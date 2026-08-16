import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot16_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });

const switcher = page.locator('select[aria-label="Switch restaurant"]');
if (await switcher.count()) {
  await switcher.selectOption({ label: "Img Restaurant 6421cd7d" });
  await page.waitForTimeout(600);
}

await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// Add "Chicken Momo" to the cart (Rs 220 subtotal).
const momoCard = page.locator("button", { hasText: "Chicken Momo" }).first();
await momoCard.click();
await page.waitForTimeout(300);
// A customize modal appears (variants/addons/quantity) — its submit button
// is labeled "Add to order · Rs. X.XX".
const addToOrderBtn = page.locator('button:has-text("Add to order")');
await addToOrderBtn.waitFor({ state: "visible", timeout: 5000 });
await addToOrderBtn.click();
await page.waitForTimeout(300);

await page.screenshot({ path: "/tmp/pos-loyalty-01-cart.png", fullPage: true });

// Search for the loyalty customer by phone.
const searchInput = page.locator('input[placeholder="Search by name or phone…"]');
await searchInput.fill("9812345678");
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/pos-loyalty-02-search.png", fullPage: true });

const resultBtn = page.locator("button", { hasText: "9812345678" }).first();
await resultBtn.click();
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/pos-loyalty-03-attached.png", fullPage: true });

// Redeem 50 points.
const redeemInput = page.locator('input[placeholder="Points to redeem"]');
await redeemInput.fill("50");
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/pos-loyalty-04-redeem-preview.png", fullPage: true });

// Submit the order.
const placeOrderBtn = page.locator('button:has-text("Place order")');
if ((await placeOrderBtn.count()) === 0) {
  console.log("Place order button not found; dumping visible buttons");
  const buttons = await page.locator("button").allTextContents();
  console.log(JSON.stringify(buttons));
}
await placeOrderBtn.click();
await page.waitForURL(/\/dashboard\/orders\//, { timeout: 10000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/pos-loyalty-05-order-detail.png", fullPage: true });

console.log("Order URL:", page.url());

await browser.close();
