// Phase 15: screenshot check for menu item images across MenuManager, POS,
// and the public QR order menu. Uses the pre-seeded restaurant/items from
// the setup that must run immediately before this script.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot15_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });

// --- Menu management: card grid with images -------------------------------
await page.goto(`${BASE}/dashboard/menu`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/menu-manager-cards.png", fullPage: true });
console.log("saved /tmp/menu-manager-cards.png");

// Open the edit form for the image-having item to check the upload UI
const editButtons = page.locator('button:has-text("Edit")');
if (await editButtons.count()) {
  await editButtons.first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/menu-manager-form-upload.png", fullPage: true });
  console.log("saved /tmp/menu-manager-form-upload.png");

  // Upload a real local file via the hidden file input to exercise the
  // client-side resize/compress path end to end.
  const fileInput = page.locator('input[type="file"]');
  if (await fileInput.count()) {
    await fileInput.setInputFiles("/tmp/sample-momo.jpg");
    await page.waitForTimeout(600);
    await page.screenshot({ path: "/tmp/menu-manager-form-uploaded.png", fullPage: true });
    console.log("saved /tmp/menu-manager-form-uploaded.png");
  }
  await page.keyboard.press("Escape").catch(() => {});
}

// --- POS: image-forward item cards -----------------------------------------
await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/pos-item-cards.png", fullPage: true });
console.log("saved /tmp/pos-item-cards.png");

await context.close();

// --- Public QR menu (no auth needed — fresh unauthenticated context) -------
const context2 = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page2 = await context2.newPage();
// Discover a QR token by creating a table via the API isn't done here to
// keep this script read-only against existing data — instead, read the
// token written by the setup step if present.
try {
  const token = readFileSync("/tmp/screenshot15_qr_token.txt", "utf8").trim();
  await page2.goto(`${BASE}/order/${token}`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(800);
  await page2.screenshot({ path: "/tmp/public-menu-cards.png", fullPage: true });
  console.log("saved /tmp/public-menu-cards.png");
} catch {
  console.log("WARNING: no QR token file found, skipping public menu screenshot");
}

await context2.close();
await browser.close();
console.log("done");
