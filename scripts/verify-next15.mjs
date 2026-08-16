import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot16_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
await page.waitForTimeout(1500);

const title = await page.locator("h1, p.text-base").first().textContent().catch(() => null);
console.log("Dashboard loaded, title area:", title);

const bell = page.locator('button[aria-label="Notifications"]');
console.log("Notification bell present:", await bell.count() > 0);

const posLink = page.locator('a:has-text("Open POS")');
console.log("Open POS link present:", await posLink.count() > 0);

const dateToggle = page.locator('[aria-label="Calendar system"]');
console.log("AD/BS toggle present:", await dateToggle.count() > 0);

await page.screenshot({ path: "/tmp/next15-dashboard.png" });
await browser.close();
console.log("DONE");
