import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase8d";
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
// "Phase8dTour" for reliable cleanup. ----------------------------------------
let sessionCookie = "";
{
  const { res, cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Phase8dTour Owner",
      phone,
      email: `phase8d.${suffix}@example.com`,
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
    name: "Phase8dTour Momo House",
    type: "momo_shop",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811119992",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("slug", slug);

const table1 = await api(`/api/restaurants/${slug}/tables`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Phase8dTour Table 1" }),
});
const table2 = await api(`/api/restaurants/${slug}/tables`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "Phase8dTour Table 2" }),
});
const tableId1 = table1.data.table.id;
const tableId2 = table2.data.table.id;

// Use "today" so the dashboard's default date filter shows these without
// needing to change the date picker in the screenshot.
const today = new Date().toISOString().slice(0, 10);

async function addReservation({ customerName, customerPhone, partySize, tableId, hour, notes }) {
  const r = await api(`/api/restaurants/${slug}/reservations`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      customerName,
      customerPhone,
      partySize,
      tableId,
      reservationTime: `${today}T${String(hour).padStart(2, "0")}:00:00.000Z`,
      notes,
    }),
  });
  return r.data.reservation;
}

const r1 = await addReservation({
  customerName: "Phase8dTour Requested Party",
  customerPhone: "9812340001",
  partySize: 2,
  hour: 18,
});
const r2 = await addReservation({
  customerName: "Phase8dTour Confirmed Party",
  customerPhone: "9812340002",
  partySize: 4,
  tableId: tableId1,
  hour: 19,
  notes: "Phase8dTour window seat requested",
});
const r3 = await addReservation({
  customerName: "Phase8dTour Seated Party",
  customerPhone: "9812340003",
  partySize: 6,
  tableId: tableId2,
  hour: 20,
  notes: "Phase8dTour birthday, need high chair",
});

// Advance r2 to confirmed, r3 all the way to seated, so the list shows a
// spread of statuses (and status action buttons) in one screenshot.
await api(`/api/restaurants/${slug}/reservations/${r2.id}/status`, {
  method: "PATCH",
  headers: authHeaders,
  body: JSON.stringify({ status: "confirmed" }),
});
await api(`/api/restaurants/${slug}/reservations/${r3.id}/status`, {
  method: "PATCH",
  headers: authHeaders,
  body: JSON.stringify({ status: "confirmed" }),
});
await api(`/api/restaurants/${slug}/reservations/${r3.id}/status`, {
  method: "PATCH",
  headers: authHeaders,
  body: JSON.stringify({ status: "seated" }),
});
console.log("reservations seeded:", { requested: r1.id, confirmed: r2.id, seated: r3.id });

// --- Playwright: log in through the real UI and tour the Reservations board
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

// 1. Reservations list for today, showing a spread of statuses
await page.goto(`${BASE}/dashboard/reservations`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Phase8dTour Seated Party", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/70-reservations-list.png`, fullPage: true });
console.log("captured 70-reservations-list");

// 2. New-reservation form open
await page.getByRole("button", { name: "+ New reservation", exact: true }).click();
await page.waitForSelector("text=Date & time", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/71-reservations-add-form.png`, fullPage: true });
console.log("captured 71-reservations-add-form");

await browser.close();
console.log("DONE");
