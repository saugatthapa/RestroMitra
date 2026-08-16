import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase8c";
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
// "Phase8cTour" for reliable cleanup. ----------------------------------------
let sessionCookie = "";
{
  const { res, cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase8cTour Owner",
      phone,
      email: `phase8c.${suffix}@example.com`,
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
    name: "Phase8cTour Momo House",
    type: "momo_shop",
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

async function addExpense({ category, amount, description, expenseDate }) {
  const r = await api(`/api/restaurants/${slug}/expenses`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ category, amount, description, expenseDate }),
  });
  return r.data.expense;
}

await addExpense({
  category: "rent",
  amount: 25000,
  description: "Phase8cTour Shrawan rent",
  expenseDate: "2026-08-01",
});
await addExpense({
  category: "utilities",
  amount: 1750,
  description: "Phase8cTour electricity bill",
  expenseDate: "2026-08-05",
});
await addExpense({
  category: "supplies",
  amount: 850,
  description: "Phase8cTour napkins and takeaway boxes",
  expenseDate: "2026-08-10",
});
await addExpense({
  category: "salaries",
  amount: 18000,
  description: "Phase8cTour kitchen staff salary",
  expenseDate: "2026-08-12",
});
console.log("expenses seeded");

// --- Playwright: log in through the real UI and tour the Expenses board ----
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

// 1. Expenses list with category totals
await page.goto(`${BASE}/dashboard/expenses`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Phase8cTour kitchen staff salary", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/60-expenses-list.png`, fullPage: true });
console.log("captured 60-expenses-list");

// 2. Add-expense form open
await page.getByRole("button", { name: "+ Add expense", exact: true }).click();
await page.waitForSelector("text=Description", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/61-expenses-add-form.png`, fullPage: true });
console.log("captured 61-expenses-add-form");
await page.getByRole("button", { name: "Cancel", exact: true }).first().click();

// 3. Category filter applied (utilities)
await page.selectOption("select", { label: "Utilities" });
await page.waitForSelector("text=Phase8cTour electricity bill", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/62-expenses-filtered.png`, fullPage: true });
console.log("captured 62-expenses-filtered");

await browser.close();
console.log("DONE");
