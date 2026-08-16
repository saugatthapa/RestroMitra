import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { execSync } from "child_process";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase10";
mkdirSync(OUT, { recursive: true });

const H = { "Content-Type": "application/json", "x-dhankipos-client": "web" };
const rand8 = () => String(Math.floor(10000000 + Math.random() * 89999999));
const suffix = Math.random().toString(36).slice(2, 8);

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

function psql(sql) {
  return execSync(
    `psql postgresql://postgres:localdevpass@127.0.0.1:5432/dhankipos_dev -tA -c "${sql.replace(/"/g, '\\"')}"`,
  )
    .toString()
    .trim();
}

// --- Seed: an owner still inside their trial ---------------------------------
const trialPhone = `98${rand8()}`;
const password = "testpass123";
let trialCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase10Tour Trial Owner",
      phone: trialPhone,
      email: `phase10.trial.${suffix}@example.com`,
      password,
    }),
  });
  trialCookie = cookie.split(";")[0];
}
const trialOnb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: trialCookie },
  body: JSON.stringify({
    name: "Phase10Tour Trial Cafe",
    type: "cafe",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110020",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const trialSlug = trialOnb.data.slug;
console.log("trial restaurant", trialSlug);

// --- Seed: an owner whose trial has already lapsed ----------------------------
const blockedPhone = `96${rand8()}`;
let blockedCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase10Tour Blocked Owner",
      phone: blockedPhone,
      email: `phase10.blocked.${suffix}@example.com`,
      password,
    }),
  });
  blockedCookie = cookie.split(";")[0];
}
const blockedOnb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: blockedCookie },
  body: JSON.stringify({
    name: "Phase10Tour Blocked Bistro",
    type: "restaurant",
    address: "Main Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9822220020",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const blockedSlug = blockedOnb.data.slug;
const blockedId = psql(`select id from restaurants where slug = '${blockedSlug}'`);
psql(`update restaurants set trial_ends_at = now() - interval '3 days' where id = '${blockedId}'`);
// Trigger the lazy reconciliation so subscription_status actually flips to
// "expired" (mirrors what a real visit does) before we screenshot /billing.
// The billing route itself deliberately skips this check (it must stay
// reachable while blocked), so hit an ordinary gated route instead.
await api(`/api/restaurants/${blockedSlug}/reports/summary`, { headers: { Cookie: blockedCookie } });
console.log("blocked restaurant", blockedSlug);

// --- Seed: a third restaurant, assigned an active paid plan (for a mixed
// admin overview list) ---------------------------------------------------------
const activePhone = `97${rand8()}`;
let activeCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase10Tour Active Owner",
      phone: activePhone,
      email: `phase10.active.${suffix}@example.com`,
      password,
    }),
  });
  activeCookie = cookie.split(";")[0];
}
const activeOnb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: activeCookie },
  body: JSON.stringify({
    name: "Phase10Tour Active Diner",
    type: "restaurant",
    address: "Bhanuchowk",
    city: "Itahari",
    district: "Sunsari",
    phone: "9833330020",
    openTime: "08:00",
    closeTime: "22:00",
  }),
});
const activeSlug = activeOnb.data.slug;
const activeId = psql(`select id from restaurants where slug = '${activeSlug}'`);
console.log("active restaurant", activeSlug);

// --- Platform admin (seeded via DB — deliberately no self-serve path) --------
const adminPhone = `98${rand8()}`;
let adminCookie = "";
{
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase10Tour Platform Admin",
      phone: adminPhone,
      email: `phase10.admin.${suffix}@example.com`,
      password,
    }),
  });
  adminCookie = cookie.split(";")[0];
}
const adminUserId = psql(`select id from users where phone = '${adminPhone}'`);
psql(`insert into user_roles (user_id, restaurant_id, branch_id, role) values ('${adminUserId}', null, null, 'platform_admin')`);
{
  // Re-login so the session reflects the freshly-granted platform_admin role.
  const { cookie } = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: adminPhone, password }),
  });
  adminCookie = cookie.split(";")[0];
}

// Use the admin session to assign+activate a paid plan on the "active" tenant,
// so the overview table shows a mix of trialing/expired/active statuses.
await api(`/api/admin/restaurants/${activeId}/subscription`, {
  method: "PATCH",
  headers: { Cookie: adminCookie },
  body: JSON.stringify({ action: "assign_plan", planKey: "growth", activate: true, note: "Phase10Tour seed" }),
});
console.log("admin seeded");

// --- Playwright: log in through the real UI for each persona and tour -------
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
  await page.waitForURL(/\/(dashboard|billing)/, { timeout: 10000 });
  return { context, page };
}

// 1. /billing — still inside the trial window
{
  const { page, context } = await loginAs(trialPhone);
  await page.goto(`${BASE}/billing`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Free trial", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/80-billing-trialing.png`, fullPage: true });
  console.log("captured 80-billing-trialing");
  await context.close();
}

// 2. /billing — trial lapsed, blocked callout + plan grid to upgrade
{
  const { page, context } = await loginAs(blockedPhone);
  await page.goto(`${BASE}/billing`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Access to your dashboard is paused", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/81-billing-blocked.png`, fullPage: true });
  console.log("captured 81-billing-blocked");

  // Also show a plan "request" in progress.
  const requestButtons = page.getByRole("button", { name: /Request this plan/i });
  if (await requestButtons.count()) {
    await requestButtons.first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/82-billing-plan-requested.png`, fullPage: true });
    console.log("captured 82-billing-plan-requested");
  }
  await context.close();
}

// 3. /admin overview — stat tiles + mixed-status restaurant list
{
  const { page, context } = await loginAs(adminPhone);
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Platform admin", { timeout: 10000 });
  await page.fill('input[placeholder*="Search" i]', "Phase10Tour").catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/83-admin-overview.png`, fullPage: true });
  console.log("captured 83-admin-overview");

  // 4. /admin/restaurants/[id] — the blocked tenant's detail + action panel
  await page.goto(`${BASE}/admin/restaurants/${blockedId}`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Subscription timeline", { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: `${OUT}/84-admin-restaurant-detail.png`, fullPage: true });
  console.log("captured 84-admin-restaurant-detail");
  await context.close();
}

await browser.close();
console.log("DONE");
