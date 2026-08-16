import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase8";
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
      fullName: "Phase8 Tour Owner",
      phone,
      email: `phase8.${suffix}@example.com`,
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
    name: "Phase8 Tour Momo House",
    type: "momo_shop",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811119995",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("slug", slug);

async function addStaff({ staffPhone, fullName, role }) {
  const r = await api(`/api/restaurants/${slug}/staff`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ phone: staffPhone, fullName, password, role }),
  });
  return r.data.staff;
}

const managerPhone = `97${Math.floor(10000000 + Math.random() * 89999999)}`;
const waiterPhone = `96${Math.floor(10000000 + Math.random() * 89999999)}`;
const kitchenPhone = `98${Math.floor(10000000 + Math.random() * 89999999)}`;

const manager = await addStaff({ staffPhone: managerPhone, fullName: "Sita Manager", role: "manager" });
const waiter = await addStaff({ staffPhone: waiterPhone, fullName: "Ram Waiter", role: "waiter" });
await addStaff({ staffPhone: kitchenPhone, fullName: "Hari Kitchen Staff", role: "kitchen_staff" });
console.log("staff seeded:", { manager: manager.id, waiter: waiter.id });

// Log the waiter in and have them clock in, so the Attendance tab has a
// real "still clocked in" row when the owner views it.
const waiterLogin = await api("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ phone: waiterPhone, password }),
});
const waiterCookie = waiterLogin.cookie.split(";")[0];
await api(`/api/restaurants/${slug}/attendance/clock-in`, {
  method: "POST",
  headers: { Cookie: waiterCookie },
  body: JSON.stringify({ note: "Opened the floor" }),
});
console.log("waiter clocked in");

// Owner also clocks themselves in and out once, for a completed-shift row.
await api(`/api/restaurants/${slug}/attendance/clock-in`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ note: "Morning prep" }),
});
await api(`/api/restaurants/${slug}/attendance/clock-out`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ note: "Handed off to the floor" }),
});

// --- Playwright: log in through the real UI and tour the Staff board -------
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

// 1. Roster tab (default)
await page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Sita Manager", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/40-staff-roster.png`, fullPage: true });
console.log("captured 40-staff-roster");

// 2. Attendance tab — owner sees everyone's shifts, including the waiter's open one
await page.getByRole("button", { name: "Attendance", exact: true }).click();
await page.waitForSelector("text=Ram Waiter", { timeout: 10000 });
await page.waitForSelector("text=Still clocked in", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/41-staff-attendance.png`, fullPage: true });
console.log("captured 41-staff-attendance");

// 3. Add-staff form open
await page.getByRole("button", { name: "Roster", exact: true }).click();
await page.waitForSelector("text=Sita Manager", { timeout: 10000 });
await page.getByRole("button", { name: "+ Add staff", exact: true }).click();
await page.waitForSelector("text=Full name (new accounts only)", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/42-staff-add-form.png`, fullPage: true });
console.log("captured 42-staff-add-form");

await browser.close();
console.log("DONE");
