import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-responsive";
mkdirSync(OUT, { recursive: true });

const H = { "Content-Type": "application/json", "x-dhankipos-client": "web" };
const rand8 = () => String(Math.floor(10000000 + Math.random() * 89999999));
const suffix = Math.random().toString(36).slice(2, 8);
const password = "testpass123";

function fakeIp() {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
}

async function api(path, opts = {}, cookie = "") {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...H,
      "x-forwarded-for": fakeIp(),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  const data = await res.json().catch(() => ({}));
  return { res, data, cookie: setCookie ? setCookie.split(";")[0] : cookie };
}

// --- Seed: owner + restaurant + menu + tables + a few live orders ----------
const ownerPhone = `98${rand8()}`;
let ownerCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Responsive QA Owner",
      phone: ownerPhone,
      email: `responsive.owner.${suffix}@example.com`,
      password,
    }),
  });
  ownerCookie = cookie;
}
const onb = await api(
  "/api/onboarding/restaurant",
  {
    method: "POST",
    body: JSON.stringify({
      name: "Responsive QA Restaurant",
      type: "restaurant",
      address: "Dharan Road",
      city: "Itahari",
      district: "Sunsari",
      phone: "9811110099",
      openTime: "09:00",
      closeTime: "21:00",
    }),
  },
  ownerCookie,
);
const slug = onb.data.slug;
console.log("restaurant:", slug);

// Two categories, a few menu items — one with variants + addons so the
// customize modal (a likely mobile trouble spot) can also be screenshotted.
const cat1 = await api(`/api/restaurants/${slug}/categories`, { method: "POST", body: JSON.stringify({ name: "Momos" }) }, ownerCookie);
const cat2 = await api(`/api/restaurants/${slug}/categories`, { method: "POST", body: JSON.stringify({ name: "Drinks" }) }, ownerCookie);
const categoryId1 = cat1.data.category.id;
const categoryId2 = cat2.data.category.id;

const item1 = await api(
  `/api/restaurants/${slug}/menu-items`,
  { method: "POST", body: JSON.stringify({ categoryId: categoryId1, name: "Chicken Momo", price: 180 }) },
  ownerCookie,
);
const menuItemId1 = item1.data.menuItem.id;
await api(
  `/api/restaurants/${slug}/menu-items/${menuItemId1}/variants`,
  { method: "POST", body: JSON.stringify({ name: "Steamed (10 pcs)", price: 180 }) },
  ownerCookie,
);
await api(
  `/api/restaurants/${slug}/menu-items/${menuItemId1}/variants`,
  { method: "POST", body: JSON.stringify({ name: "Fried (10 pcs)", price: 200 }) },
  ownerCookie,
);
await api(
  `/api/restaurants/${slug}/menu-items/${menuItemId1}/addons`,
  { method: "POST", body: JSON.stringify({ name: "Extra chutney", price: 20 }) },
  ownerCookie,
);

let simpleMenuItemId = null;
for (const name of ["Veg Momo", "Buff Momo", "Jhol Momo"]) {
  const r = await api(`/api/restaurants/${slug}/menu-items`, { method: "POST", body: JSON.stringify({ categoryId: categoryId1, name, price: 160 }) }, ownerCookie);
  if (!simpleMenuItemId) simpleMenuItemId = r.data.menuItem.id;
}
for (const name of ["Coke", "Lassi"]) {
  await api(`/api/restaurants/${slug}/menu-items`, { method: "POST", body: JSON.stringify({ categoryId: categoryId2, name, price: 90 }) }, ownerCookie);
}

const table1 = await api(`/api/restaurants/${slug}/tables`, { method: "POST", body: JSON.stringify({ name: "T1", capacity: 4 }) }, ownerCookie);
await api(`/api/restaurants/${slug}/tables`, { method: "POST", body: JSON.stringify({ name: "T2", capacity: 2 }) }, ownerCookie);
const tableId1 = table1.data.table.id;

// A handful of orders spread across the KDS columns (confirmed / preparing /
// ready) with a couple of items and notes each, so the board isn't empty
// when screenshotted.
async function placeOrder(customerName, tableId) {
  const r = await api(
    `/api/restaurants/${slug}/orders`,
    {
      method: "POST",
      body: JSON.stringify({
        tableId: tableId ?? null,
        items: [
          { menuItemId: simpleMenuItemId, quantity: 2, notes: "Extra spicy please" },
          { menuItemId: simpleMenuItemId, quantity: 1 },
        ],
        customerName,
      }),
    },
    ownerCookie,
  );
  if (!r.data.order) {
    console.error("placeOrder failed:", r.res.status, JSON.stringify(r.data));
    throw new Error("placeOrder failed");
  }
  return r.data.order.id;
}
async function setStatus(orderId, status) {
  await api(`/api/restaurants/${slug}/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, ownerCookie);
}

const orderA = await placeOrder("Sita Rai", tableId1);
await setStatus(orderA, "confirmed");

const orderB = await placeOrder("Walk-in", null);
await setStatus(orderB, "confirmed");
await setStatus(orderB, "preparing");

const orderC = await placeOrder("Hari Thapa", null);
await setStatus(orderC, "confirmed");
await setStatus(orderC, "preparing");
await setStatus(orderC, "ready");

console.log("seeded menu, tables, and 3 live orders across KDS columns");

// --- Playwright: capture POS + KDS at tablet and phone breakpoints ---------
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

const VIEWPORTS = [
  { key: "tablet-landscape", width: 1024, height: 768 },
  { key: "tablet-portrait", width: 768, height: 1024 },
  { key: "phone-large", width: 414, height: 896 },
  { key: "phone-small", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.width < 768, hasTouch: vp.width < 1024 });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="98XXXXXXXX"]', ownerPhone);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 10000 });

  // POS
  await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Current order", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/pos-${vp.key}.png`, fullPage: true });
  console.log(`captured pos-${vp.key}`);

  // POS: open the customize modal (variants + addons) — a likely trouble
  // spot for small screens (bottom sheet vs. centered modal).
  await page.click("text=Chicken Momo");
  await page.waitForSelector("text=Choose an option", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/pos-customize-modal-${vp.key}.png`, fullPage: true });
  console.log(`captured pos-customize-modal-${vp.key}`);
  await page.keyboard.press("Escape").catch(() => {});
  await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });

  // KDS
  await page.goto(`${BASE}/dashboard/kds`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Waiting to start", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/kds-${vp.key}.png`, fullPage: true });
  console.log(`captured kds-${vp.key}`);

  await context.close();
}

await browser.close();
console.log("DONE");
