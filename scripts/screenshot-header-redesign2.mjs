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
await page.waitForTimeout(1500); // let header-status poll resolve
await page.screenshot({ path: "/tmp/header-redesign-full.png", fullPage: false });

// Zoom in on just the header
const header = page.locator("header");
await header.screenshot({ path: "/tmp/header-redesign-header-only.png" });

// Open notification bell
await page.click('button[aria-label="Notifications"]');
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/header-redesign-notif-open.png" });

// Check the Open POS link target
const posLink = page.locator('a:has-text("Open POS")');
const href = await posLink.getAttribute("href");
const target = await posLink.getAttribute("target");
console.log("Open POS href:", href, "target:", target);

await browser.close();
