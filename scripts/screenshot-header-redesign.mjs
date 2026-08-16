// Ad-hoc verification for the header redesign: restaurant monogram/logo in
// the sidebar brand slot, page-title header, live "N active"/"Kitchen"
// status pills, and the restaurant switcher (now that the test owner has
// two restaurants). Also exercises the onboarding logo-upload path end to
// end with a real image file.
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

// Give the header-status poll a moment to land (it fires immediately on
// mount, but wait for the network round trip).
await page.waitForResponse((r) => r.url().includes("/header-status")).catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/header-with-switcher.png" });
console.log("saved /tmp/header-with-switcher.png");

// Zoom into just the header row for a close look at the pills + switcher.
await page.locator("header").screenshot({ path: "/tmp/header-closeup.png" });
console.log("saved /tmp/header-closeup.png");

// Switch restaurants via the header dropdown.
await page.selectOption('select[aria-label="Switch restaurant"]', { label: "Sunrise Cafe QA" });
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/header-after-switch.png" });
console.log("saved /tmp/header-after-switch.png");

await context.close();

// --- Onboarding: real logo upload end to end -------------------------------
const context2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page2 = await context2.newPage();

// Register a brand-new owner so onboarding starts fresh.
const suffix = Math.random().toString(36).slice(2, 8);
const newPhone = `98${String(Math.floor(10000000 + Math.random() * 89999999))}`;
await page2.goto(`${BASE}/register`, { waitUntil: "networkidle" });
await page2.fill('input[placeholder="Sita Rai"]', `QA Logo Owner ${suffix}`);
await page2.fill('input[placeholder="98XXXXXXXX"]', newPhone);
await page2.fill('input[placeholder="At least 8 characters"]', "testpass123");
await Promise.all([
  page2.waitForURL(`${BASE}/onboarding`, { timeout: 10000 }).catch(() => {}),
  page2.click('button[type="submit"]'),
]);
await page2.waitForTimeout(600);

if (page2.url().includes("/onboarding")) {
  await page2.fill('input[placeholder*="Momo House"]', `Logo QA Restaurant ${suffix}`);
  const fileInput = page2.locator('input[type="file"]');
  await fileInput.setInputFiles("/tmp/sample-momo.jpg");
  await page2.waitForTimeout(600);
  await page2.screenshot({ path: "/tmp/onboarding-logo-step0.png" });
  console.log("saved /tmp/onboarding-logo-step0.png");

  // Step through the rest of the wizard with minimal valid input.
  await page2.click('button:has-text("Next")'); // -> type
  await page2.click('button:has-text("Cafe")');
  await page2.click('button:has-text("Next")'); // -> address
  await page2.fill('input[placeholder="Street address"]', "Test Street");
  await page2.fill('input[placeholder="Restaurant phone (98XXXXXXXX)"]', "9811122233");
  await page2.click('button:has-text("Next")'); // -> pan/vat
  await page2.click('button:has-text("Next")'); // -> hours
  await page2.click('button:has-text("Next")'); // -> review
  await page2.screenshot({ path: "/tmp/onboarding-logo-review.png" });
  console.log("saved /tmp/onboarding-logo-review.png");

  await Promise.all([
    page2.waitForResponse((r) => r.url().includes("/api/onboarding/restaurant")),
    page2.click('button:has-text("Create restaurant")'),
  ]);
  await page2.waitForTimeout(600);
  await page2.click('button:has-text("Go to dashboard")');
  await page2.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
  await page2.waitForTimeout(500);
  await page2.screenshot({ path: "/tmp/dashboard-real-logo.png" });
  console.log("saved /tmp/dashboard-real-logo.png");
} else {
  console.log("registration did not land on /onboarding — url was", page2.url());
}

await context2.close();
await browser.close();
