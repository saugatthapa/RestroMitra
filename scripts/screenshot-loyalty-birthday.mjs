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
await page.waitForTimeout(600);

await page.click('button:has-text("+ Add customer")');
await page.waitForTimeout(400);
await page.fill('input[placeholder="98XXXXXXXX"]', "9811122333");
await page.fill('input[type="date"]', "1998-08-16");
await page.getByLabel("Full name").fill("Birthday Test Customer");

await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/loyalty-00-form-filled.png", fullPage: true });

await Promise.all([
  page.waitForResponse((r) => r.url().includes("/customers") && r.request().method() === "POST"),
  page.click('button:has-text("Add customer")'),
]);
await page.waitForTimeout(1200);

await page.fill('input[placeholder="Search by name or phone…"]', "Birthday Test Customer");
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/loyalty-01-list-birthday.png", fullPage: true });

await page.click('tr:has-text("Birthday Test Customer")');
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/loyalty-02-detail-birthday.png", fullPage: true });

await browser.close();
