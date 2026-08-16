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

await page.goto(`${BASE}/dashboard/website`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

await Promise.all([
  page.waitForResponse((r) => r.url().includes("/website") && r.request().method() === "PATCH"),
  page.click('button:has-text("Unpublish")'),
]);
await page.waitForTimeout(500);
console.log("Unpublished via dashboard");

const status = await page.evaluate(async () => {
  const res = await fetch("/site/img-restaurant-6421cd7d");
  return res.status;
});
console.log("Public site status after unpublish:", status);

// Republish to leave the test restaurant in a "live" state for any later checks
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/website") && r.request().method() === "PATCH"),
  page.click('button:has-text("Publish website")'),
]);
console.log("Re-published");

await browser.close();
