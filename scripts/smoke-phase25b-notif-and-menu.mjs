import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const PHONE = "9800330999";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ["notifications"],
});
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

console.log("1. Login + dashboard...");
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', PHONE);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
await page.waitForTimeout(1500);
console.log("   OK - dashboard loaded");

console.log("2. Looking for notification permission gate / test control...");
const enableBtn = page.locator('button:has-text("Turn on notifications")');
if (await enableBtn.count()) {
  await enableBtn.click();
  await page.waitForTimeout(1500);
  console.log("   Clicked 'Turn on notifications'");
}
const testBtn = page.locator('button:has-text("Send test notification")');
await page.waitForTimeout(500);
if (await testBtn.count()) {
  console.log("   Test-notification control is visible (permission granted state)");
  await testBtn.click();
  await page.waitForTimeout(2000);
  const statusText = await page.locator("text=/Notifications are on for this device/").textContent().catch(() => null);
  console.log("   Status line:", statusText);
} else {
  console.log("   Test-notification control NOT visible (permission may not have been granted in headless context)");
}

console.log("3. Console/page errors so far:", errors.length ? errors.slice(0, 5) : "none");

console.log("4. Checking QR order menu renders with the new design (already screenshotted separately)...");

await browser.close();
console.log("Done.");
