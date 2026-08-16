import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase11a";
mkdirSync(OUT, { recursive: true });

const H = { "Content-Type": "application/json", "x-dhankipos-client": "web" };
const rand8 = () => String(Math.floor(10000000 + Math.random() * 89999999));
const suffix = Math.random().toString(36).slice(2, 8);
const password = "testpass123";

// The register/login routes are IP-rate-limited (5/min) — spread requests
// across fake IPs the same way the bash smoke tests do, so seeding several
// accounts back-to-back doesn't trip the limiter.
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

// --- Seed: an owner + restaurant (auto-creates the Main branch) --------------
const ownerPhone = `98${rand8()}`;
let ownerCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase11aTour Owner",
      phone: ownerPhone,
      email: `phase11a.owner.${suffix}@example.com`,
      password,
    }),
  });
  ownerCookie = cookie.split(";")[0];
}
const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({
    name: "Phase11aTour Restaurant",
    type: "restaurant",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110040",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("restaurant", slug);

// --- Create a second branch ---------------------------------------------------
const branchRes = await api(`/api/restaurants/${slug}/branches`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ name: "Dharan Branch", city: "Dharan", address: "Vijaypur Road" }),
});
const secondBranchId = branchRes.data.branch.id;
console.log("second branch", secondBranchId);

// --- Invite a manager scoped to the second branch -----------------------------
const managerPhone = `97${rand8()}`;
await api(`/api/restaurants/${slug}/staff`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({
    phone: managerPhone,
    fullName: "Phase11aTour Dharan Manager",
    password,
    role: "manager",
    branchId: secondBranchId,
  }),
});
console.log("manager invited");

// --- A couple of tables in each branch, so the filter has something to show -
await api(`/api/restaurants/${slug}/tables`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ name: "Main Hall 1", capacity: 4 }),
});
await api(`/api/restaurants/${slug}/tables`, {
  method: "POST",
  headers: { Cookie: ownerCookie },
  body: JSON.stringify({ name: "Dharan Table 1", capacity: 4, branchId: secondBranchId }),
});
console.log("tables seeded");

// --- Playwright: log in through the real UI and tour ------------------------
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

async function loginAs(phone) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="98XXXXXXXX"]', phone);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 10000 });
  return { context, page };
}

// 1. /dashboard/branches — branch list with the Main + Dharan branch cards
{
  const { page, context } = await loginAs(ownerPhone);
  await page.goto(`${BASE}/dashboard/branches`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Dharan Branch", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/90-branches-list.png`, fullPage: true });
  console.log("captured 90-branches-list");

  // 2. Add-branch form open
  await page.getByRole("button", { name: "+ Branch" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/91-branches-add-form.png`, fullPage: true });
  console.log("captured 91-branches-add-form");

  // 3. /dashboard/tables — branch filter dropdown in action
  await page.goto(`${BASE}/dashboard/tables`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Dharan Table 1", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/92-tables-all-branches.png`, fullPage: true });
  console.log("captured 92-tables-all-branches");

  const branchFilter = page.locator("select").first();
  await branchFilter.selectOption({ label: "Dharan Branch" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/93-tables-filtered-dharan.png`, fullPage: true });
  console.log("captured 93-tables-filtered-dharan");

  // 4. /dashboard/staff — roster showing the branch-scoped manager + branch column
  await page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Phase11aTour Dharan Manager", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/94-staff-roster-with-branch.png`, fullPage: true });
  console.log("captured 94-staff-roster-with-branch");

  // 5. Staff invite form with the branch picker visible
  const inviteToggle = page.getByRole("button", { name: "+ Add staff" }).first();
  if (await inviteToggle.count()) {
    await inviteToggle.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/95-staff-invite-branch-picker.png`, fullPage: true });
    console.log("captured 95-staff-invite-branch-picker");
  }

  await context.close();
}

await browser.close();
console.log("DONE");
