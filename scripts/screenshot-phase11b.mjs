import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase11b";
mkdirSync(OUT, { recursive: true });

const H = { "Content-Type": "application/json", "x-dhankipos-client": "web" };
const rand8 = () => String(Math.floor(10000000 + Math.random() * 89999999));
const suffix = Math.random().toString(36).slice(2, 8);
const password = "testpass123";

function fakeIp() {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...H, "x-forwarded-for": fakeIp(), ...(opts.headers ?? {}) },
  });
  const cookie = res.headers.get("set-cookie");
  const data = await res.json().catch(() => ({}));
  return { res, data, cookie };
}

// --- Seed: owner + restaurant + a menu item + a table ------------------------
const ownerPhone = `98${rand8()}`;
let ownerCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase11bTour Owner",
      phone: ownerPhone,
      email: `phase11b.owner.${suffix}@example.com`,
      password,
    }),
  });
  ownerCookie = cookie.split(";")[0];
}
const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({
    name: "Phase11bTour Restaurant",
    type: "restaurant",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110060",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("restaurant", slug);

const catRes = await api(`/api/restaurants/${slug}/categories`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ name: "Momos" }),
});
const categoryId = catRes.data.category.id;

await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ categoryId, name: "Chicken Momo", price: 180 }),
});
await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ categoryId, name: "Veg Momo", price: 150 }),
});
console.log("menu seeded");

// --- Playwright: log in, tour the POS page's offline behavior ----------------
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', ownerPhone);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL(/\/dashboard/, { timeout: 10000 });

// 1. POS page, online — normal menu, no offline banner.
await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Chicken Momo", { timeout: 10000 });
// Give the service worker a moment to install/activate — best-effort only
// (bounded by a hard timeout, since navigator.serviceWorker.ready never
// resolves at all in a headless/sandboxed environment where workers are
// disabled, and this tour's real subject — the IndexedDB order queue — does
// not depend on it).
await Promise.race([
  page.evaluate(() => navigator.serviceWorker.ready).catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 3000)),
]);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/96-pos-online.png`, fullPage: true });
console.log("captured 96-pos-online");

// 2. Go offline, add an item, submit — should queue instead of erroring.
await context.setOffline(true);
await page.waitForTimeout(300);
await page.getByText("Chicken Momo").click();
await page.waitForSelector("text=Add to order");
await page.getByRole("button", { name: /Add to order/ }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/97-pos-offline-cart.png`, fullPage: true });
console.log("captured 97-pos-offline-cart");

await page.getByRole("button", { name: /Save order \(offline\)/ }).click();
await page.waitForSelector("text=waiting to sync", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/98-pos-offline-queued.png`, fullPage: true });
console.log("captured 98-pos-offline-queued");

// 3. Back online — the queued order should auto-sync within a few seconds.
await context.setOffline(false);
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/99-pos-synced.png`, fullPage: true });
console.log("captured 99-pos-synced");

await context.close();
await browser.close();

// --- Verify the queued order actually landed server-side --------------------
const ordersRes = await api(`/api/restaurants/${slug}/orders`, {
  headers: { Cookie: ownerCookie },
});
const synced = ordersRes.data.orders?.some((o) =>
  o.items?.some((i) => i.menuItemNameSnapshot === "Chicken Momo"),
);
console.log(synced ? "VERIFIED: offline order synced to the server" : "WARNING: offline order NOT found server-side");

console.log("DONE");
