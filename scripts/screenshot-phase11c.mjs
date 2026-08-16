import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { createHmac } from "node:crypto";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase11c";
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

// --- Seed: owner + restaurant + menu item + two orders -----------------------
const ownerPhone = `98${rand8()}`;
let ownerCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase11cTour Owner",
      phone: ownerPhone,
      email: `phase11c.owner.${suffix}@example.com`,
      password,
    }),
  });
  ownerCookie = cookie.split(";")[0];
}
const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({
    name: "Phase11cTour Restaurant",
    type: "restaurant",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110062",
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
const itemRes = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ categoryId, name: "Chicken Momo", price: 180 }),
});
const menuItemId = itemRes.data.menuItem.id;
console.log("menu seeded");

const order1 = await api(`/api/restaurants/${slug}/orders`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ items: [{ menuItemId, quantity: 2 }], customerName: "Walk-in" }),
});
const order1Id = order1.data.order.id;

const order2 = await api(`/api/restaurants/${slug}/orders`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }], customerName: "Walk-in" }),
});
const order2Id = order2.data.order.id;
console.log("orders seeded", order1Id, order2Id);

// --- Playwright: log in, view the unpaid bill with the wallet buttons --------
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

// 1. Order bill view, unpaid — shows "Pay with a wallet" (eSewa/Khalti) buttons.
await page.goto(`${BASE}/dashboard/orders/${order1Id}`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Pay via eSewa", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/100-order-unpaid-gateway-buttons.png`, fullPage: true });
console.log("captured 100-order-unpaid-gateway-buttons");

// --- Simulate a completed eSewa payment for order2, entirely server-side ----
// (Mirrors exactly what scripts/smoke-test-phase11c.sh does over curl: call
// our own initiate route, then build a signed callback payload the same way
// eSewa itself would, since eSewa's signature is pure local HMAC-SHA256.)
const initRes = await api(`/api/restaurants/${slug}/orders/${order2Id}/payments/gateway/esewa/initiate`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({}),
});
const { transaction_uuid: txnUuid, total_amount: totalAmount } = initRes.data.fields;

const esewaSecret = "8gBm/:&EnhH.1/q(";
const message = `total_amount=${totalAmount},transaction_uuid=${txnUuid},product_code=EPAYTEST`;
const signature = createHmac("sha256", esewaSecret).update(message).digest("base64");
const dataParam = Buffer.from(
  JSON.stringify({
    transaction_code: "0000AB",
    status: "COMPLETE",
    total_amount: totalAmount,
    transaction_uuid: txnUuid,
    product_code: "EPAYTEST",
    signed_field_names: "total_amount,transaction_uuid,product_code",
    signature,
  }),
).toString("base64");

const callbackUrl = `${BASE}/api/payments/gateway/esewa/callback?outcome=success&ref=${txnUuid}&data=${encodeURIComponent(dataParam)}`;
await fetch(callbackUrl, { redirect: "manual" });
console.log("simulated eSewa callback for order2");

// 2. Order bill view after landing back from the gateway — success banner,
//    payment history showing the mobile-wallet payment, buttons gone (paid).
await page.goto(`${BASE}/dashboard/orders/${order2Id}?payment=success`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Payment received", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/101-order-paid-via-gateway.png`, fullPage: true });
console.log("captured 101-order-paid-via-gateway");

await context.close();
await browser.close();

// --- Verify server-side: order2 is paid via mobile_wallet -------------------
const detail = await api(`/api/restaurants/${slug}/orders/${order2Id}`, {
  headers: { Cookie: ownerCookie },
});
const paid = detail.data.billing?.paymentStatus === "paid";
const method = detail.data.order?.payments?.[0]?.method;
console.log(
  paid && method === "mobile_wallet"
    ? "VERIFIED: order2 paid via mobile_wallet gateway payment"
    : `WARNING: unexpected state — paymentStatus=${detail.data.billing?.paymentStatus} method=${method}`,
);

console.log("DONE");
