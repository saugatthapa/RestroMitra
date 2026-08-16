import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase9";
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

// --- Seed data over HTTP (fast, reliable) — every entity name prefixed
// "Phase9Tour" for reliable cleanup. ------------------------------------------
let sessionCookie = "";
{
  const { res, cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase9Tour Owner",
      phone,
      email: `phase9.${suffix}@example.com`,
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
    name: "Phase9Tour Momo House",
    type: "momo_shop",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811119994",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("slug", slug);

const cat = await api(`/api/restaurants/${slug}/categories`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Phase9Tour MOMO" }),
});
const categoryId = cat.data.category.id;

async function addMenuItem(name, price) {
  const r = await api(`/api/restaurants/${slug}/menu-items`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ categoryId, name, price }),
  });
  return r.data.menuItem.id;
}

const momoId = await addMenuItem("Phase9Tour Steam Momo", 180);
const drinkId = await addMenuItem("Phase9Tour Cold Drink", 60);
const thukpaId = await addMenuItem("Phase9Tour Thukpa", 220);
console.log("menu seeded");

async function placeAndComplete(items, paymentMethod, customerName) {
  const { data } = await api(`/api/restaurants/${slug}/orders`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ items, customerName }),
  });
  const orderId = data.order.id;
  for (const status of ["confirmed", "preparing", "ready", "served", "completed"]) {
    await api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ status }),
    });
  }
  const totalRupees = data.order.totalInPaisa / 100;
  await api(`/api/restaurants/${slug}/orders/${orderId}/payments`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ amount: totalRupees, method: paymentMethod }),
  });
  return orderId;
}

// Spread a handful of completed orders across the last few days so the
// trend chart has real day-to-day variation to render, not a flat line.
const today = new Date();
function daysAgoIso(days) {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

await placeAndComplete([{ menuItemId: momoId, quantity: 3 }], "cash", "Phase9Tour Guest 1");
await placeAndComplete(
  [{ menuItemId: momoId, quantity: 2 }, { menuItemId: drinkId, quantity: 2 }],
  "card",
  "Phase9Tour Guest 2",
);
await placeAndComplete([{ menuItemId: thukpaId, quantity: 4 }], "mobile_wallet", "Phase9Tour Guest 3");
await placeAndComplete([{ menuItemId: momoId, quantity: 1 }, { menuItemId: thukpaId, quantity: 1 }], "cash", "Phase9Tour Guest 4");
console.log("orders seeded and completed");

async function addExpense(category, amount, description) {
  await api(`/api/restaurants/${slug}/expenses`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ category, amount, description, expenseDate: daysAgoIso(1) }),
  });
}
await addExpense("rent", 15000, "Phase9Tour rent");
await addExpense("supplies", 3200, "Phase9Tour supplies");
await addExpense("utilities", 1800, "Phase9Tour electricity");
console.log("expenses seeded");

// --- Playwright: log in through the real UI and tour the Reports board -----
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 10000 });

// 1. Reports dashboard — KPI tiles, trend chart, top items, breakdowns
await page.goto(`${BASE}/dashboard/reports`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Net profit", { timeout: 10000 });
await page.waitForSelector("text=Phase9Tour Steam Momo", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/70-reports-overview.png`, fullPage: true });
console.log("captured 70-reports-overview");

// 2. Hover the trend chart to show the crosshair + tooltip
const svg = page.locator("svg[aria-label='Revenue vs expenses over time']");
const box = await svg.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/71-reports-chart-hover.png`, fullPage: true });
  console.log("captured 71-reports-chart-hover");
}

// 3. "Show as table" toggle on the chart
await page.getByRole("button", { name: "Show as table" }).click();
await page.waitForSelector("table", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/72-reports-chart-table-view.png`, fullPage: true });
console.log("captured 72-reports-chart-table-view");

// 4. "Today" preset applied — filter row + KPI tiles re-render
await page.getByRole("button", { name: "Show chart" }).click();
await page.getByRole("button", { name: "Today", exact: true }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/73-reports-today-preset.png`, fullPage: true });
console.log("captured 73-reports-today-preset");

await browser.close();
console.log("DONE");
