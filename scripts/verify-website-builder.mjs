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
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/website-01-initial.png", fullPage: true });
console.log("Loaded dashboard/website");

// Fill tagline
await page.fill('input[placeholder="e.g. Authentic Newari cuisine since 2010"]', "Best momo in town");

// Pick "Modern" theme
await page.click('button:has-text("Modern")');

// Fill about
await page.fill('textarea[placeholder="Tell customers what makes your place worth visiting."]', "We serve fresh momo daily.");

// Fill contact/social
await page.fill('input[placeholder="Facebook URL"]', "https://facebook.com/imgrestaurant");
await page.fill('input[placeholder="WhatsApp number (98XXXXXXXX)"]', "9812345678");

// Check first featured menu item checkbox if present
const firstCheckbox = page.locator('label:has(span:text("Chicken Momo")) input[type="checkbox"]');
if (await firstCheckbox.count()) {
  await firstCheckbox.check();
  console.log("Checked Chicken Momo as featured");
}

// Save changes
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/website") && r.request().method() === "PATCH"),
  page.click('button:has-text("Save changes")'),
]);
await page.waitForTimeout(500);
console.log("Saved changes");
await page.screenshot({ path: "/tmp/website-02-saved.png", fullPage: true });

// Publish
const publishBtn = page.locator('button:has-text("Publish website")');
if (await publishBtn.count()) {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/website") && r.request().method() === "PATCH"),
    publishBtn.click(),
  ]);
  await page.waitForTimeout(500);
  console.log("Published");
}
await page.screenshot({ path: "/tmp/website-03-published.png", fullPage: true });

// Get siteUrl text
const siteUrlText = await page.locator("text=/\\/site\\//").first().textContent().catch(() => null);
console.log("Site URL shown:", siteUrlText);

// Fetch the API directly to confirm state
const apiResult = await page.evaluate(async () => {
  const res = await fetch("/api/restaurants/img-restaurant-6421cd7d/website", {
    headers: { "x-dhankipos-client": "web" },
  });
  return { status: res.status, body: await res.json() };
});
console.log("GET /website API:", JSON.stringify(apiResult, null, 2).slice(0, 800));

await browser.close();
