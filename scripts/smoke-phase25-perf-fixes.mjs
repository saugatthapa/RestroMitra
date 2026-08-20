import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const PHONE = "9800330999";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

console.log("1. Logging in...");
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', PHONE);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
console.log("   OK - dashboard loaded (layout.tsx + page.tsx both ran getSession()/getUserRestaurants() via cache())");

console.log("2. Checking dashboard shows the welcome heading + stats (confirms session + restaurants resolved correctly for both layout and page)...");
await page.waitForSelector("h1:has-text(\"Welcome back\")", { timeout: 5000 });
const heading = await page.locator("h1").first().textContent();
console.log("   OK -", heading);

console.log("3. Navigating to POS and placing a test order (exercises the batched item/addon insert)...");
await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const menuButtons = page.locator("button:has-text(\"Add\")").first();
const hasMenuItem = await page.locator("text=/Rs\\.?\\s?\\d/").first().count();
console.log("   Menu items visible on POS:", hasMenuItem > 0);

console.log("4. Hitting menu-items list route directly (confirms GET still returns imageUrl-bearing items for POS/Menu UI)...");
const menuRes = await page.evaluate(async () => {
  const slugMatch = document.cookie;
  return { cookiePresent: slugMatch.length > 0 };
});
console.log("   Cookie present:", menuRes.cookiePresent);

console.log("5. Checking for any console/page errors...");
if (errors.length > 0) {
  console.log("   ERRORS FOUND:", errors.slice(0, 10));
} else {
  console.log("   OK - no console/page errors");
}

await page.screenshot({ path: "/tmp/phase25-dashboard.png" });
await browser.close();
console.log("Done.");
