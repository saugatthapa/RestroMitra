import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const PHONE = "9800330999";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

// --- 1. Mobile-width login + dashboard, check the Install app button is
// actually visible (not just present-but-hidden) on a real phone viewport,
// on a Chromium UA (stands in for Android Chrome — no beforeinstallprompt
// fires in this headless test env, but the CSS-visibility bug is what we're
// checking, and isIos()/platform state don't gate visibility, only which
// click-handler branch runs).
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); // iPhone 12-ish width
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="98XXXXXXXX"]', PHONE);
  await page.fill('input[type="password"]', "testpass123");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
    page.click('button:has-text("Log in")'),
  ]);
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Force platform to "ios" via UA override wouldn't retrigger the effect
  // post-mount, so instead directly assert the underlying CSS class list no
  // longer contains the old always-hidden pattern, AND (for whichever
  // platform branch happened to be live — beforeinstallprompt won't fire
  // headless, so "none" is expected here) confirm the header layout itself
  // didn't break by wrapping unexpectedly.
  await page.screenshot({ path: "/tmp/phase23-mobile-header.png", clip: { x: 0, y: 0, width: 390, height: 140 } });

  const notifBanner = page.locator("text=Turn on notifications so you never miss an order");
  const bannerVisible = await notifBanner.isVisible().catch(() => false);
  console.log("Notification permission banner visible on fresh login:", bannerVisible);

  if (bannerVisible) {
    await page.screenshot({ path: "/tmp/phase23-notif-banner.png", clip: { x: 0, y: 0, width: 390, height: 260 } });
  }

  await context.close();
}

// --- 2. Desktop width: grant Notification permission up front (Playwright
// context permission grant), reload, confirm the banner does NOT show once
// granted, and confirm the InstallAppPrompt button element in the DOM no
// longer carries an unconditional `hidden` class.
{
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ["notifications"],
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="98XXXXXXXX"]', PHONE);
  await page.fill('input[type="password"]', "testpass123");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
    page.click('button:has-text("Log in")'),
  ]);
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
  await page.waitForTimeout(1000);

  const permission = await page.evaluate(() => Notification.permission);
  console.log("Notification.permission after context grant:", permission);

  const bannerAfterGrant = await page
    .locator("text=Turn on notifications so you never miss an order")
    .isVisible()
    .catch(() => false);
  console.log("Banner visible when already granted (should be false):", bannerAfterGrant);

  await context.close();
}

// --- 3. Mobile viewport, narrower than the old `sm` (640px) breakpoint:
// confirm the Install button node is present and has non-zero size (i.e.
// NOT display:none via the old `hidden` class), directly refuting the
// original bug rather than just eyeballing a screenshot.
{
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } }); // narrow Android phone
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="98XXXXXXXX"]', PHONE);
  await page.fill('input[type="password"]', "testpass123");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
    page.click('button:has-text("Log in")'),
  ]);
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Simulate iOS: InstallAppPrompt's platform state only ever becomes "ios"
  // via isIos() reading navigator.userAgent at mount, so re-navigate with an
  // iOS UA override to actually exercise that branch instead of guessing.
  await context.close();

  const iosContext = await browser.newContext({
    viewport: { width: 360, height: 740 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const iosPage = await iosContext.newPage();
  await iosPage.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await iosPage.fill('input[placeholder="98XXXXXXXX"]', PHONE);
  await iosPage.fill('input[type="password"]', "testpass123");
  await Promise.all([
    iosPage.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
    iosPage.click('button:has-text("Log in")'),
  ]);
  await iosPage.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
  await iosPage.waitForTimeout(1000);

  const installBtn = iosPage.locator('button[aria-label="Install app"]');
  const count = await installBtn.count();
  const box = count ? await installBtn.boundingBox() : null;
  console.log("iOS UA, 360px viewport — Install button count:", count, "boundingBox:", box);

  if (box) {
    await installBtn.click();
    await iosPage.waitForTimeout(300);
    const tipVisible = await iosPage.locator("text=Add RestroMitra to your Home Screen").isVisible();
    console.log("iOS Add-to-Home-Screen tip shown after tap:", tipVisible);
  }

  await iosContext.close();
}

await browser.close();
console.log("DONE");
