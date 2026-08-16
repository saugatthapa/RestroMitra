// Ad-hoc screenshot check for the sidebar/nav redesign — grouped sections,
// icons, collapse rail, and the bottom profile card, on desktop, collapsed,
// and mobile drawer.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot16_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

// --- Desktop: expanded sidebar ---------------------------------------------
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
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/nav-desktop-expanded.png" });
console.log("saved /tmp/nav-desktop-expanded.png");

// --- Desktop: collapsed rail -----------------------------------------------
await page.click('button[aria-label="Collapse sidebar"]');
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/nav-desktop-collapsed.png" });
console.log("saved /tmp/nav-desktop-collapsed.png");

// Hover a nav icon to confirm the title tooltip attribute renders (native
// tooltips don't screenshot reliably, but this exercises the path without
// throwing).
await page.hover('a[title="Orders"]').catch(() => {});
await page.waitForTimeout(200);

// Expand again and check an active route highlights correctly
await page.click('button[aria-label="Expand sidebar"]');
await page.waitForTimeout(300);
await page.goto(`${BASE}/dashboard/reports`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/nav-desktop-reports-active.png" });
console.log("saved /tmp/nav-desktop-reports-active.png");

await context.close();

// --- Mobile drawer -----------------------------------------------------
const context2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page2 = await context2.newPage();
await page2.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page2.fill('input[placeholder="98XXXXXXXX"]', phone);
await page2.fill('input[type="password"]', "testpass123");
await Promise.all([
  page2.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page2.click('button:has-text("Log in")'),
]);
await page2.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
await page2.waitForTimeout(500);
await page2.click('button[aria-label="Open menu"]');
await page2.waitForTimeout(400);
await page2.screenshot({ path: "/tmp/nav-mobile-drawer.png" });
console.log("saved /tmp/nav-mobile-drawer.png");

await context2.close();
await browser.close();
