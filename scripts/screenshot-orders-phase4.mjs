import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase3";
mkdirSync(OUT, { recursive: true });

const suffix = Math.random().toString(36).slice(2, 8);
const phone = `98${Math.floor(10000000 + Math.random() * 89999999)}`;
const password = "testpass123";
const H = { "Content-Type": "application/json", "x-dhankipos-client": "web" };

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...H, ...(opts.headers ?? {}) },
  });
  const cookie = res.headers.get("set-cookie");
  const data = await res.json().catch(() => ({}));
  return { res, data, cookie };
}

// --- Seed data over HTTP (fast, reliable) -----------------------------------
let sessionCookie = "";
{
  const { res, cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase4 Tour Owner",
      phone,
      email: `phase4.${suffix}@example.com`,
      password,
    }),
  });
  if (!res.ok) throw new Error("register failed");
  sessionCookie = cookie.split(";")[0];
}

const authHeaders = { Cookie: sessionCookie };

const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "Phase4 Tour Cafe",
    type: "cafe",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811119999",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("slug", slug);

const cat = await api(`/api/restaurants/${slug}/categories`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "MOMO" }),
});
const categoryId = cat.data.category.id;

const item1 = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId, name: "Buff Momo", price: 180, taxRatePercent: 13 }),
});
const item2 = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId, name: "Chicken Chowmein", price: 220, taxRatePercent: 13 }),
});
const itemId1 = item1.data.menuItem.id;
const itemId2 = item2.data.menuItem.id;

const tables = [];
for (const name of ["Table 1", "Table 2", "Table 3", "Table 4", "Table 5"]) {
  const t = await api(`/api/restaurants/${slug}/tables`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name }),
  });
  tables.push(t.data.table);
}

async function placeOrder(tableToken, itemId, qty = 1) {
  const r = await api(`/api/order/${tableToken}`, {
    method: "POST",
    body: JSON.stringify({ items: [{ menuItemId: itemId, quantity: qty }] }),
  });
  return r.data.order;
}

async function setStatus(orderId, status) {
  return api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ status }),
  });
}

// One order per status column for a representative screenshot.
const oPending = await placeOrder(tables[0].qrToken, itemId1, 2);

const oConfirmed = await placeOrder(tables[1].qrToken, itemId2, 1);
await setStatus(oConfirmed.id, "confirmed");

const oPreparing = await placeOrder(tables[2].qrToken, itemId1, 3);
await setStatus(oPreparing.id, "confirmed");
await setStatus(oPreparing.id, "preparing");

const oReady = await placeOrder(tables[3].qrToken, itemId2, 2);
await setStatus(oReady.id, "confirmed");
await setStatus(oReady.id, "preparing");
await setStatus(oReady.id, "ready");

const oServed = await placeOrder(tables[4].qrToken, itemId1, 1);
await setStatus(oServed.id, "confirmed");
await setStatus(oServed.id, "preparing");
await setStatus(oServed.id, "ready");
await setStatus(oServed.id, "served");

console.log("orders seeded:", { oPending: oPending.id, oConfirmed: oConfirmed.id });

// --- Playwright: log in through the real UI and screenshot the board -------
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 10000 });

await page.goto(`${BASE}/dashboard/orders`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200); // let the poll's first load settle
await page.screenshot({ path: `${OUT}/10-orders-board.png`, fullPage: true });
console.log("captured 10-orders-board");

await browser.close();
console.log("DONE");
