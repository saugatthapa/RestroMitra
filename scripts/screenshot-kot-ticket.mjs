import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot16_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
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

// --- Set a custom KOT header via the KDS "Ticket settings" panel first ---
await page.goto(`${BASE}/dashboard/kds`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.locator('button:has-text("Ticket settings")').click();
await page.waitForTimeout(400);
const headerInput = page.locator('input[placeholder="Restaurant name"], input[placeholder*="Restaurant"]').first();
await headerInput.fill("Img Kitchen Copy");
await page.locator('button:has-text("Save")').click();
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/kot-01-settings.png", fullPage: true });

// --- Place a fresh order in POS with items on two different stations ---
await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

async function addItem(name) {
  await page.locator("button", { hasText: name }).first().click();
  await page.waitForTimeout(200);
  const addBtn = page.locator('button:has-text("Add to order")');
  await addBtn.waitFor({ state: "visible", timeout: 5000 });
  await addBtn.click();
  await page.waitForTimeout(200);
}

await addItem("Chicken Momo");
await addItem("Veg Thukpa");

page.on("dialog", async (dialog) => {
  console.log("DIALOG:", dialog.message());
  await dialog.dismiss();
});

await page.locator('button:has-text("Place order")').click();
await page.waitForURL(/\/dashboard\/orders\//, { timeout: 10000 });
const orderUrl = page.url();
console.log("Order URL:", orderUrl);
await page.waitForTimeout(500);

// --- Confirm the order directly from its own detail page (deterministic —
// no need to re-find it in a polling board list). ---
const [popup] = await Promise.all([
  context.waitForEvent("page", { timeout: 15000 }),
  page.locator('button:has-text("Confirm")').click(),
]);
await popup.waitForLoadState("networkidle");
await popup.waitForTimeout(1200);
await popup.screenshot({ path: "/tmp/kot-02-ticket.png", fullPage: true });

console.log("Popup URL:", popup.url());

await browser.close();
