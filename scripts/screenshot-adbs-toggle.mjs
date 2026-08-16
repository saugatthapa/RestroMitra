import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot16_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const header = page.locator("header");
await header.screenshot({ path: "/tmp/adbs-header-bs.png" });

// Read the BS label, toggle to AD, screenshot again.
const group = page.locator('[aria-label="Calendar system"]');
const bsLabelBefore = await header.locator("text=/\\d{4}/").first().textContent();
console.log("Default (BS) label:", bsLabelBefore);

await group.locator('button:has-text("AD")').click();
await page.waitForTimeout(200);
await header.screenshot({ path: "/tmp/adbs-header-ad.png" });
const adLabel = await header.locator("text=/\\d{4}/").first().textContent();
console.log("After clicking AD:", adLabel);

// Reload — should persist as AD via localStorage.
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const pressed = await page.locator('[aria-label="Calendar system"] button[aria-pressed="true"]').textContent();
console.log("Persisted selection after reload:", pressed);

await browser.close();
