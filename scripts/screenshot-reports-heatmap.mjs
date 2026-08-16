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

await page.goto(`${BASE}/dashboard/reports`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

await page.screenshot({ path: "/tmp/reports-heatmap-orders.png", fullPage: true });
console.log("saved /tmp/reports-heatmap-orders.png");

const revenueBtn = page.locator('button:has-text("By revenue")');
if (await revenueBtn.count()) {
  await revenueBtn.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/reports-heatmap-revenue.png", fullPage: true });
  console.log("saved /tmp/reports-heatmap-revenue.png");
}

// The heatmap's "Show as table" is the 2nd such button on the page (the
// Revenue-vs-expenses line chart has one too).
const tableBtn = page.locator('button:has-text("Show as table")').nth(1);
if (await tableBtn.count()) {
  await tableBtn.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/reports-heatmap-table.png", fullPage: true });
  console.log("saved /tmp/reports-heatmap-table.png");
}

await browser.close();
