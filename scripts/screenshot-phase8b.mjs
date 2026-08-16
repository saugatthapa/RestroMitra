import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase8b";
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

// --- Seed data over HTTP (fast, reliable) — every entity name is prefixed
// "Phase8bTour" so cleanup can find it, even sub-accounts and customers
// (a Phase 8a cleanup gap: see PHASE_8_NOTES.md's lessons-learned note). ---
let sessionCookie = "";
{
  const { res, cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase8bTour Owner",
      phone,
      email: `phase8b.${suffix}@example.com`,
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
    name: "Phase8bTour Momo House",
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
  body: JSON.stringify({ name: "Phase8bTour MOMO" }),
});
const catId = cat.data.category.id;

const menuItem = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId: catId, name: "Phase8bTour Chicken Momo", price: 220 }),
});
const menuItemId = menuItem.data.menuItem.id;

// --- Three customers at different loyalty stages, so the list view shows a
// realistic tier spread (Bronze / Silver / Gold) rather than three identical rows.
async function addCustomer({ custPhone, fullName, email }) {
  const r = await api(`/api/restaurants/${slug}/customers`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ phone: custPhone, fullName, email }),
  });
  return r.data.customer;
}

async function completeOrder(customerId, quantity) {
  // A single line item is capped at 50 by createStaffOrderSchema — split
  // larger requested quantities across multiple completed orders instead.
  if (quantity > 50) {
    await completeOrder(customerId, 50);
    await completeOrder(customerId, quantity - 50);
    return;
  }
  const order = await api(`/api/restaurants/${slug}/orders`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      items: [{ menuItemId, quantity }],
      customerId,
    }),
  });
  if (!order.res.ok) {
    throw new Error(`order create failed: ${JSON.stringify(order.data)}`);
  }
  const orderId = order.data.order.id;
  for (const status of ["confirmed", "preparing", "ready", "served", "completed"]) {
    await api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ status }),
    });
  }
}

const custBronzePhone = `97${Math.floor(10000000 + Math.random() * 89999999)}`;
const custSilverPhone = `96${Math.floor(10000000 + Math.random() * 89999999)}`;
const custGoldPhone = `98${Math.floor(10000000 + Math.random() * 89999999)}`;

const custBronze = await addCustomer({
  custPhone: custBronzePhone,
  fullName: "Phase8bTour Customer Bronze",
  email: `bronze.${suffix}@example.com`,
});
const custSilver = await addCustomer({
  custPhone: custSilverPhone,
  fullName: "Phase8bTour Customer Silver",
  email: `silver.${suffix}@example.com`,
});
const custGold = await addCustomer({
  custPhone: custGoldPhone,
  fullName: "Phase8bTour Customer Gold",
  email: `gold.${suffix}@example.com`,
});
console.log("customers seeded:", { custBronze: custBronze.id, custSilver: custSilver.id, custGold: custGold.id });

// Bronze: one small order (well under Silver's 500-point threshold).
await completeOrder(custBronze.id, 1); // Rs 220 -> 22 points

// Silver: enough completed orders to cross 500 lifetime points.
await completeOrder(custSilver.id, 25); // Rs 5500 -> 550 points

// Gold: enough to cross 1500 lifetime points.
await completeOrder(custGold.id, 70); // Rs 15400 -> 1540 points

// A manual goodwill credit on the Gold customer, so the loyalty ledger in
// the detail view shows more than one transaction type.
await api(`/api/restaurants/${slug}/customers/${custGold.id}/loyalty/adjust`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ points: 50, direction: "add", reason: "Phase8bTour goodwill credit" }),
});

console.log("orders completed, loyalty points awarded");

// --- Playwright: log in through the real UI and tour the Customers board --
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

// 1. Customer list, showing the tier spread
await page.goto(`${BASE}/dashboard/customers`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Phase8bTour Customer Gold", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/50-customers-list.png`, fullPage: true });
console.log("captured 50-customers-list");

// 2. Customer detail view — Gold tier customer with order history + ledger
await page.getByText("Phase8bTour Customer Gold").click();
await page.waitForSelector("text=Gold tier", { timeout: 10000 });
await page.waitForSelector("text=Loyalty ledger", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/51-customer-detail-gold.png`, fullPage: true });
console.log("captured 51-customer-detail-gold");

// 3. Adjust-points form open
await page.getByRole("button", { name: "Adjust points", exact: true }).click();
await page.waitForSelector("text=Current balance:", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/52-customer-adjust-points.png`, fullPage: true });
console.log("captured 52-customer-adjust-points");

// 4. Back to list, open the add-customer form
await page.getByText("← Back to customers").click();
await page.waitForSelector("text=Phase8bTour Customer Gold", { timeout: 10000 });
await page.getByRole("button", { name: "+ Add customer", exact: true }).click();
await page.waitForSelector("text=Full name", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/53-customers-add-form.png`, fullPage: true });
console.log("captured 53-customers-add-form");

await browser.close();
console.log("DONE");
