// Phase 12 — live concurrency verification for the reservation
// double-booking fix and the table-status row lock.
//
// Same reasoning as scripts/qa-hardening-verify.mjs: these races can only
// be proven with GENUINE concurrent HTTP requests against the real running
// server + real Postgres, since the routes authenticate via next/headers
// cookies() (request-scoped, only present through the actual server).
const BASE = "http://localhost:3100";
const H = { "Content-Type": "application/json", "x-dhankipos-client": "web" };
let PASS = 0;
let FAIL = 0;

function assert(desc, cond, extra = "") {
  if (cond) {
    PASS++;
    console.log(`  OK   ${desc}`);
  } else {
    FAIL++;
    console.log(`  FAIL ${desc} ${extra}`);
  }
}

function fakeIp() {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
}
const rand8 = () => String(Math.floor(10000000 + Math.random() * 89999999));
const suffix = Math.random().toString(36).slice(2, 8);
const password = "testpass123";

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...H, "x-forwarded-for": fakeIp(), ...(opts.headers ?? {}) },
  });
  const cookie = res.headers.get("set-cookie");
  const data = await res.json().catch(() => ({}));
  return { res, data, cookie: cookie ? cookie.split(";")[0] : null };
}

async function registerOwner(label) {
  const phone = `98${rand8()}`;
  const { cookie } = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      fullName: `Phase12Concurrency ${label} Owner`,
      phone,
      email: `phase12conc.${label}.${suffix}.${rand8()}@example.com`,
      password,
    }),
  });
  return { phone, cookie };
}

console.log("== Phase 12: live concurrency verification ==\n");

const owner = await registerOwner("owner");
const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: owner.cookie },
  body: JSON.stringify({
    name: "Phase12Concurrency Restaurant",
    type: "restaurant",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110071",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("restaurant:", slug);

// ============================================================================
// 1. Two concurrent reservation requests for the SAME table + overlapping
//    window must not both succeed — requireTableRowLock (FOR UPDATE) should
//    serialize them so exactly one wins and the other sees a 409.
// ============================================================================
console.log("\n-- 1. Concurrent overlapping reservations on the same table --");
{
  const tableRes = await api(`/api/restaurants/${slug}/tables`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ name: "Concurrency Table 1", capacity: 4 }),
  });
  const tableId = tableRes.data.table.id;

  const body = (name) =>
    JSON.stringify({
      customerName: name,
      customerPhone: "9811119999",
      partySize: 2,
      tableId,
      reservationTime: "2026-10-01T18:00:00.000Z",
      durationMinutes: 90,
    });

  const [r1, r2] = await Promise.all([
    api(`/api/restaurants/${slug}/reservations`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: body("Race Party A"),
    }),
    api(`/api/restaurants/${slug}/reservations`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: body("Race Party B"),
    }),
  ]);

  const statuses = [r1.res.status, r2.res.status].sort();
  assert(
    "exactly one concurrent reservation succeeds (201) and the other is rejected (409)",
    statuses[0] === 201 && statuses[1] === 409,
    `got ${JSON.stringify(statuses)}`,
  );

  // Confirm at the DB level: only one reservation actually exists for this
  // exact overlapping window.
  const list = await api(`/api/restaurants/${slug}/reservations?date=2026-10-01`, {
    headers: { Cookie: owner.cookie },
  });
  const forTable = (list.data.reservations ?? []).filter((r) => r.tableId === tableId);
  assert(
    "exactly one reservation row exists for this table/window after the race",
    forTable.length === 1,
    `found ${forTable.length}`,
  );
}

// ============================================================================
// 2. Two concurrent reservation requests for DIFFERENT non-overlapping
//    windows on the same table must BOTH succeed (the lock serializes, but
//    doesn't over-reject legitimate concurrent bookings).
// ============================================================================
console.log("\n-- 2. Concurrent non-overlapping reservations on the same table --");
{
  const tableRes = await api(`/api/restaurants/${slug}/tables`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ name: "Concurrency Table 2", capacity: 4 }),
  });
  const tableId = tableRes.data.table.id;

  const [r1, r2] = await Promise.all([
    api(`/api/restaurants/${slug}/reservations`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({
        customerName: "Lunch Party",
        customerPhone: "9811118888",
        partySize: 2,
        tableId,
        reservationTime: "2026-10-02T12:00:00.000Z",
        durationMinutes: 60,
      }),
    }),
    api(`/api/restaurants/${slug}/reservations`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({
        customerName: "Dinner Party",
        customerPhone: "9811117777",
        partySize: 2,
        tableId,
        reservationTime: "2026-10-02T19:00:00.000Z",
        durationMinutes: 60,
      }),
    }),
  ]);

  assert(
    "both non-overlapping concurrent reservations succeed",
    r1.res.status === 201 && r2.res.status === 201,
    `got ${r1.res.status}, ${r2.res.status}`,
  );
}

// ============================================================================
// 3. Concurrent manual table-status PATCHes: two staff both trying to open
//    the same available table should serialize via compare-and-swap — one
//    wins, the other sees a 409 rather than both silently succeeding.
// ============================================================================
console.log("\n-- 3. Concurrent manual table-status transitions (compare-and-swap) --");
{
  const tableRes = await api(`/api/restaurants/${slug}/tables`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ name: "Concurrency Table 3" }),
  });
  const tableId = tableRes.data.table.id;

  const [r1, r2] = await Promise.all([
    api(`/api/restaurants/${slug}/tables/${tableId}/status`, {
      method: "PATCH",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ status: "ordering" }),
    }),
    api(`/api/restaurants/${slug}/tables/${tableId}/status`, {
      method: "PATCH",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ status: "ordering" }),
    }),
  ]);

  const statuses = [r1.res.status, r2.res.status].sort();
  assert(
    "exactly one concurrent 'open table' PATCH succeeds (200), the other sees a stale-status conflict (409)",
    statuses[0] === 200 && statuses[1] === 409,
    `got ${JSON.stringify(statuses)}`,
  );
}

console.log(`\n== Results: ${PASS} passed, ${FAIL} failed ==`);
if (FAIL > 0) process.exit(1);
