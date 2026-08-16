// Phase 12b: responsive screenshot check for the floor plan on tablet and
// phone breakpoints, using the pre-seeded test restaurant/tables from the
// shell setup that ran just before this script. Logs in through the real
// UI form rather than replaying a cookie jar, since the session cookie is
// signed/scoped in ways curl's jar doesn't roundtrip cleanly into Playwright.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const breakpoints = [
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "phone-390", width: 390, height: 844 },
];

for (const bp of breakpoints) {
  const context = await browser.newContext({ viewport: { width: bp.width, height: bp.height } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="98XXXXXXXX"]', phone);
  await page.fill('input[type="password"]', "testpass123");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
    page.click('button:has-text("Log in")'),
  ]);
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
  await page.goto(`${BASE}/dashboard/tables`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/floorplan-${bp.name}.png`, fullPage: false });
  console.log(`saved /tmp/floorplan-${bp.name}.png`);

  // Also open a table's detail panel to check the modal at this size.
  const tableBox = page.locator("div.absolute.flex.cursor-grab").first();
  if (await tableBox.count()) {
    await tableBox.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `/tmp/floorplan-detail-${bp.name}.png`, fullPage: false });
    console.log(`saved /tmp/floorplan-detail-${bp.name}.png`);
  } else {
    console.log(`WARNING: no table box found at ${bp.name}`);
  }

  await context.close();
}

await browser.close();
console.log("done");
