import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase5";
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
      fullName: "Phase5 Tour Owner",
      phone,
      email: `phase5.${suffix}@example.com`,
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
    name: "Phase5 Tour Cafe",
    type: "cafe",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811119998",
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
console.log("menu items seeded:", item1.data.menuItem?.id, item2.data.menuItem?.id);

const table = await api(`/api/restaurants/${slug}/tables`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Table 1" }),
});
console.log("table seeded:", table.data.table?.id);

// A second, already-placed order to screenshot a mid-payment bill view.
const posOrder = await api(`/api/restaurants/${slug}/orders`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    items: [{ menuItemId: item1.data.menuItem.id, quantity: 2 }],
    customerName: "Walk-in guest",
  }),
});
const orderId = posOrder.data.order.id;
await api(`/api/restaurants/${slug}/orders/${orderId}/payments`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ amount: 200, method: "cash", receivedAmount: 200 }),
});
console.log("seeded order with a partial payment:", orderId);

// --- Playwright: log in through the real UI and walk the POS + bill flows ---
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const dialogQueue = [];
page.on("dialog", async (dialog) => {
  const next = dialogQueue.shift();
  if (next === undefined) {
    await dialog.dismiss();
  } else {
    await dialog.accept(next);
  }
});

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 10000 });

// 1. POS screen, menu browsing
await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Buff Momo", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/10-pos-menu.png`, fullPage: true });
console.log("captured 10-pos-menu");

// 2. Customize modal for an item with add-ons/variant-free base pricing
await page.click("text=Chicken Chowmein");
await page.waitForSelector("text=Add to order", { timeout: 5000 });
await page.screenshot({ path: `${OUT}/11-pos-customize-modal.png`, fullPage: true });
console.log("captured 11-pos-customize-modal");
await page.click("text=/Add to order/");

// 3. Cart populated, choose dine-in + table
await page.getByRole("button", { name: "Dine-in", exact: true }).click();
await page.waitForSelector("select", { timeout: 5000 });
await page.selectOption("select", { label: "Table 1" });
await page.screenshot({ path: `${OUT}/12-pos-cart-dinein.png`, fullPage: true });
console.log("captured 12-pos-cart-dinein");

// 4. Place the order and land on the bill view
await page.click("text=Place order");
await page.waitForURL("**/dashboard/orders/*", { timeout: 10000 });
await page.waitForSelector("text=Record a payment", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/13-order-bill-unpaid.png`, fullPage: true });
console.log("captured 13-order-bill-unpaid");

// 5. Go view the earlier order that already has a partial payment + record the rest
await page.goto(`${BASE}/dashboard/orders/${orderId}`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Partially paid", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/14-order-bill-partial.png`, fullPage: true });
console.log("captured 14-order-bill-partial");

// 6. Record the remaining balance (the amount field already defaults to the
// full remaining due) and show the order flip to Paid.
const [paymentResponse] = await Promise.all([
  page.waitForResponse((res) => res.url().includes("/payments") && res.request().method() === "POST"),
  page.click("text=/Record Rs\\./"),
]);
if (!paymentResponse.ok()) throw new Error(`payment record failed: ${paymentResponse.status()}`);
// Wait for the now-fully-paid order's "Record a payment" panel to disappear
// (remainingDueInPaisa hits 0) as the settle signal, rather than racing the
// re-render with a fixed timeout.
await page.waitForSelector("text=Record a payment", { state: "detached", timeout: 10000 });
await page.screenshot({ path: `${OUT}/15-order-bill-paid-with-refund-form.png`, fullPage: true });
console.log("captured 15-order-bill-paid-with-refund-form");

await browser.close();
console.log("DONE");
