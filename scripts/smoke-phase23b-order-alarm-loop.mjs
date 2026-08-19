import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const PHONE = "9800330999";
const TABLE_TOKEN = "y_uGKLktecCgrdsI7vqa6ODuPWX8m3U7nWXWmns3P1g";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

// Staff tab — logged in, notifications pre-granted so the Notification()
// branch is exercised too, not just the audio loop.
const staffContext = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ["notifications"],
});
const staffPage = await staffContext.newPage();
await staffPage.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await staffPage.fill('input[placeholder="98XXXXXXXX"]', PHONE);
await staffPage.fill('input[type="password"]', "testpass123");
await Promise.all([
  staffPage.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  staffPage.click('button:has-text("Log in")'),
]);
await staffPage.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });
await staffPage.waitForTimeout(1000);

async function alarmState(page) {
  return page.evaluate(() => {
    const audios = Array.from(document.querySelectorAll("audio"));
    // The order-alert Audio() instance isn't a DOM <audio> element (it's
    // constructed via `new Audio()`, kept off-DOM in a ref) — so instead
    // probe via a global hook the smoke test installs below.
    return window.__phase23AlarmProbe ? window.__phase23AlarmProbe() : null;
  });
}

// `new Audio()` instances aren't queryable from outside the React tree, so
// patch the global Audio constructor BEFORE the app's bundle runs to keep a
// handle on whichever instance gets created for /sounds/new-order-alert.wav.
await staffContext.addInitScript(() => {
  const NativeAudio = window.Audio;
  window.__phase23OrderAlertInstances = [];
  window.Audio = new Proxy(NativeAudio, {
    construct(target, args) {
      const instance = new target(...args);
      if (typeof args[0] === "string" && args[0].includes("new-order-alert")) {
        window.__phase23OrderAlertInstances.push(instance);
      }
      return instance;
    },
  });
  window.__phase23AlarmProbe = () => {
    const instances = window.__phase23OrderAlertInstances || [];
    const a = instances[instances.length - 1];
    if (!a) return { found: false };
    return { found: true, paused: a.paused, loop: a.loop, duration: a.duration, currentTime: a.currentTime };
  };
});

// Reload so the init script actually takes effect for this page load.
await staffPage.reload({ waitUntil: "networkidle" });
await staffPage.waitForTimeout(1000);

console.log("Alarm state before any order:", await alarmState(staffPage));

// Customer tab — places a real order via the public QR menu, exercising the
// actual order.created SSE publish path end to end.
const customerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const customerPage = await customerContext.newPage();
await customerPage.goto(`${BASE}/order/${TABLE_TOKEN}`, { waitUntil: "networkidle" });
await customerPage.waitForTimeout(500);

// Real flow: tap a menu item card -> detail view's "Add to cart" -> the
// floating "View cart" button -> "Checkout" -> "Place order". Text-based
// selectors since the exact DOM structure isn't the point of this test.
await customerPage.locator("text=Chicken Momo").first().click();
await customerPage.waitForTimeout(300);
await customerPage.getByRole("button", { name: /add to cart/i }).click();
await customerPage.waitForTimeout(300);
await customerPage.getByRole("button", { name: /view cart/i }).click();
await customerPage.waitForTimeout(300);
// Exact-role match — "Tax calculated at checkout" also contains the
// substring "checkout" and would otherwise win a loose text-locator match.
await customerPage.getByRole("button", { name: "Checkout", exact: true }).click();
await customerPage.waitForTimeout(300);
await customerPage.getByRole("button", { name: "Place order", exact: true }).click();
await customerPage.waitForTimeout(1500);

// Give the SSE round-trip a moment, then check the staff tab.
await staffPage.waitForTimeout(2000);

console.log("Alarm state after order placed:", await alarmState(staffPage));

const banner = staffPage.locator("text=waiting to be confirmed");
console.log("Banner visible after order placed:", await banner.isVisible().catch(() => false));

await staffPage.screenshot({ path: "/tmp/phase23b-alarm-banner.png", clip: { x: 0, y: 0, width: 1280, height: 260 } });

// Now confirm the order from the Orders board and verify the alarm stops.
await staffPage.goto(`${BASE}/dashboard/orders`, { waitUntil: "networkidle" });
await staffPage.waitForTimeout(1000);
const confirmButton = staffPage.locator('button:has-text("Confirm")').first();
await confirmButton.click();
await staffPage.waitForTimeout(1500);

console.log("Alarm state after confirming:", await alarmState(staffPage));

await staffPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
await staffPage.waitForTimeout(1000);
const bannerAfterConfirm = await staffPage.locator("text=waiting to be confirmed").isVisible().catch(() => false);
console.log("Banner visible after confirming (should be false):", bannerAfterConfirm);

await customerContext.close();
await staffContext.close();
await browser.close();
console.log("DONE");
