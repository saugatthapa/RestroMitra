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

await page.goto(`${BASE}/dashboard/customers`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await page.fill('input[placeholder="Search by name or phone…"]', "Test Loyalty Customer");
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/loyalty-03-list-streak.png", fullPage: true });

await page.click('tr:has-text("Test Loyalty Customer")');
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/loyalty-04-detail-streak.png", fullPage: true });

await browser.close();
