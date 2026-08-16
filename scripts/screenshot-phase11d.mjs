import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase11d";
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

// --- Seed: owner + restaurant + a little sales history -----------------------
const ownerPhone = `98${rand8()}`;
let ownerCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase11dTour Owner",
      phone: ownerPhone,
      email: `phase11d.owner.${suffix}@example.com`,
      password,
    }),
  });
  ownerCookie = cookie.split(";")[0];
}
const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({
    name: "Phase11dTour Restaurant",
    type: "restaurant",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110064",
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

await api(`/api/restaurants/${slug}/orders`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ items: [{ menuItemId, quantity: 2 }], customerName: "Walk-in" }),
});
console.log("seeded a little sales history");

// --- Playwright: log in, view the assistant page ----------------------------
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

// 1. Assistant page, empty state — example prompt chips.
await page.goto(`${BASE}/dashboard/assistant`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Try one of these", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/102-assistant-empty-state.png`, fullPage: true });
console.log("captured 102-assistant-empty-state");

// 2. Ask a question — no ANTHROPIC_API_KEY in this sandbox, so this
//    exercises the real failure path: a clear, non-crashing error message
//    in the chat thread rather than a silent hang or a raw 500.
await page.fill('input[placeholder*="Ask about"]', "How were sales over the last 30 days?");
await page.click('button[type="submit"]');
await page.waitForSelector("text=isn't configured", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/103-assistant-not-configured-error.png`, fullPage: true });
console.log("captured 103-assistant-not-configured-error");

await context.close();
await browser.close();

console.log("DONE");
