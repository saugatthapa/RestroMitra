import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase7";
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
      fullName: "Phase7 Tour Owner",
      phone,
      email: `phase7.${suffix}@example.com`,
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
    name: "Phase7 Tour Momo House",
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

const supplier = await api(`/api/restaurants/${slug}/suppliers`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Itahari Wholesale Traders", phone: "9801234567", address: "Itahari Bazaar" }),
});
const supplierId = supplier.data.supplier.id;

const flour = await api(`/api/restaurants/${slug}/inventory-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Flour (Maida)", unit: "kg", reorderLevel: 8, preferredSupplierId: supplierId }),
});
const chicken = await api(`/api/restaurants/${slug}/inventory-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Chicken (raw)", unit: "kg", reorderLevel: 5, preferredSupplierId: supplierId }),
});
const oil = await api(`/api/restaurants/${slug}/inventory-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Cooking Oil", unit: "l", reorderLevel: 3 }),
});
const flourId = flour.data.inventoryItem.id;
const chickenId = chicken.data.inventoryItem.id;
const oilId = oil.data.inventoryItem.id;
console.log("inventory items seeded");

// Record starting stock, then a purchase, then drop chicken low enough to
// trip the low-stock badge — makes the Items tab screenshot meaningful.
await api(`/api/restaurants/${slug}/inventory-items/${flourId}/adjustments`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ quantity: 15, direction: "add", reason: "Opening stock count" }),
});
await api(`/api/restaurants/${slug}/inventory-items/${chickenId}/adjustments`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ quantity: 4, direction: "add", reason: "Opening stock count" }),
});
await api(`/api/restaurants/${slug}/inventory-items/${oilId}/adjustments`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ quantity: 10, direction: "add", reason: "Opening stock count" }),
});

await api(`/api/restaurants/${slug}/purchases`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    supplierId,
    invoiceNumber: "INV-2026-0142",
    items: [
      { inventoryItemId: flourId, quantity: 10, unitCost: 85 },
      { inventoryItemId: oilId, quantity: 5, unitCost: 260 },
    ],
  }),
});
console.log("purchase recorded");

const category = await api(`/api/restaurants/${slug}/categories`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Momos" }),
});
const categoryId = category.data.category.id;

const momo = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ categoryId, name: "Chicken Momo (10 pc)", price: 180 }),
});
const momoId = momo.data.menuItem.id;

await api(`/api/restaurants/${slug}/menu-items/${momoId}/recipe`, {
  method: "PUT",
  headers: authHeaders,
  body: JSON.stringify({
    items: [
      { inventoryItemId: flourId, quantityPerServing: 0.15 },
      { inventoryItemId: chickenId, quantityPerServing: 0.12 },
      { inventoryItemId: oilId, quantityPerServing: 0.02 },
    ],
  }),
});
console.log("recipe saved for Chicken Momo");

// --- Playwright: log in through the real UI and tour the Inventory board ---
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

// 1. Items tab (default) — shows stock, low-stock badge, cost/unit
await page.goto(`${BASE}/dashboard/inventory`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Flour (Maida)", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/30-inventory-items.png`, fullPage: true });
console.log("captured 30-inventory-items");

// 2. Suppliers tab
await page.getByRole("button", { name: "Suppliers", exact: true }).click();
await page.waitForSelector("text=Itahari Wholesale Traders", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/31-inventory-suppliers.png`, fullPage: true });
console.log("captured 31-inventory-suppliers");

// 3. Purchases tab
await page.getByRole("button", { name: "Purchases", exact: true }).click();
await page.waitForSelector("text=INV-2026-0142", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/32-inventory-purchases.png`, fullPage: true });
console.log("captured 32-inventory-purchases");

// 4. Recipes tab — shows the Chicken Momo's ingredient list + cost/serving
await page.getByRole("button", { name: "Recipes", exact: true }).click();
await page.waitForSelector("text=Estimated ingredient cost per serving", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/33-inventory-recipes.png`, fullPage: true });
console.log("captured 33-inventory-recipes");

// 5. Adjust-stock modal open, to show that flow too
await page.getByRole("button", { name: "Items", exact: true }).click();
await page.waitForSelector("text=Flour (Maida)", { timeout: 10000 });
await page.getByRole("button", { name: "Adjust stock" }).first().click();
await page.waitForSelector("text=Adjust stock —", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/34-inventory-adjust-modal.png`, fullPage: true });
console.log("captured 34-inventory-adjust-modal");

await browser.close();
console.log("DONE");
