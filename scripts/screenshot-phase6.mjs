import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase6";
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
      fullName: "Phase6 Tour Owner",
      phone,
      email: `phase6.${suffix}@example.com`,
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
    name: "Phase6 Tour Cafe",
    type: "cafe",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811119993",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("slug", slug);

const cat = await api(`/api/restaurants/${slug}/categories`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "MAINS" }),
});
const categoryId = cat.data.category.id;

const grill = await api(`/api/restaurants/${slug}/kitchen-stations`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Grill" }),
});
const bar = await api(`/api/restaurants/${slug}/kitchen-stations`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Bar" }),
});
const grillId = grill.data.kitchenStation.id;
const barId = bar.data.kitchenStation.id;

const sizzler = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId, kitchenStationId: grillId, name: "Chicken Sizzler", price: 350 }),
});
const momo = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId, kitchenStationId: grillId, name: "Grill Momo", price: 220 }),
});
const lassi = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId, kitchenStationId: barId, name: "Sweet Lassi", price: 150 }),
});
const sizzlerId = sizzler.data.menuItem.id;
const momoId = momo.data.menuItem.id;
const lassiId = lassi.data.menuItem.id;
console.log("menu seeded across two stations");

const table = await api(`/api/restaurants/${slug}/tables`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Table 1" }),
});
const qrToken = table.data.table.qrToken;

async function placeOrder(items) {
  const r = await api(`/api/order/${qrToken}`, {
    method: "POST",
    body: JSON.stringify({ items }),
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

// One order waiting to start (confirmed), one in progress (preparing), one
// ready — spread across both stations so the board's grouping is visible.
const oConfirmed = await placeOrder([
  { menuItemId: sizzlerId, quantity: 1 },
  { menuItemId: lassiId, quantity: 2 },
]);
await setStatus(oConfirmed.id, "confirmed");

const oPreparing = await placeOrder([{ menuItemId: momoId, quantity: 3 }]);
await setStatus(oPreparing.id, "confirmed");
await setStatus(oPreparing.id, "preparing");

const oReady = await placeOrder([{ menuItemId: lassiId, quantity: 1 }]);
await setStatus(oReady.id, "confirmed");
await setStatus(oReady.id, "preparing");
await setStatus(oReady.id, "ready");

console.log("orders seeded:", { oConfirmed: oConfirmed.id, oPreparing: oPreparing.id, oReady: oReady.id });

// --- Playwright: log in through the real UI and screenshot the KDS board ---
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

// 1. All-stations view
await page.goto(`${BASE}/dashboard/kds`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Waiting to start", { timeout: 10000 });
await page.waitForTimeout(800); // let the poll's first load settle
await page.screenshot({ path: `${OUT}/20-kds-all-stations.png`, fullPage: true });
console.log("captured 20-kds-all-stations");

// 2. Filtered to the Grill station only
await page.getByRole("button", { name: "Grill", exact: true }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/21-kds-grill-station.png`, fullPage: true });
console.log("captured 21-kds-grill-station");

// 3. Advance the "waiting to start" ticket and show it move columns
await page.getByRole("button", { name: "All stations", exact: true }).click();
await page.waitForTimeout(300);
const [statusResponse] = await Promise.all([
  page.waitForResponse((res) => res.url().includes("/status") && res.request().method() === "PATCH"),
  page.getByRole("button", { name: "Start preparing" }).first().click(),
]);
if (!statusResponse.ok()) throw new Error(`status update failed: ${statusResponse.status()}`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/22-kds-after-advance.png`, fullPage: true });
console.log("captured 22-kds-after-advance");

await browser.close();
console.log("DONE");
