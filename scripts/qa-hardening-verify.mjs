// QA hardening pass — live concurrency verification.
//
// These are races that can only be proven (or disproven) with GENUINE
// concurrent HTTP requests against the real running server and real
// Postgres — a single-process unit test calling exported route handlers
// directly can't exercise this, because these routes authenticate via
// next/headers cookies(), which requires Next's own request-scoped context
// (only present when handled through the actual dev/prod server). So this
// script fires real concurrent `fetch()` calls, exactly the way two staff
// devices or a double-click would, and checks that the FOR UPDATE locks /
// compare-and-swap added in this hardening pass actually serialize them.
import { createHmac } from "node:crypto";

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
      fullName: `QAHardening ${label} Owner`,
      phone,
      email: `qa.${label}.${suffix}.${rand8()}@example.com`,
      password,
    }),
  });
  return { phone, cookie };
}

console.log("== QA hardening pass: live concurrency verification ==\n");

// --- Seed a restaurant with a menu item, recipe ingredient, and a table ----
const owner = await registerOwner("owner");
const onb = await api("/api/onboarding/restaurant", {
  method: "POST",
  headers: { Cookie: owner.cookie },
  body: JSON.stringify({
    name: "QAHardening Restaurant",
    type: "restaurant",
    address: "Dharan Road",
    city: "Itahari",
    district: "Sunsari",
    phone: "9811110070",
    openTime: "09:00",
    closeTime: "21:00",
  }),
});
const slug = onb.data.slug;
console.log("restaurant:", slug);

const catRes = await api(`/api/restaurants/${slug}/categories`, {
  method: "POST",
  headers: { Cookie: owner.cookie },
  body: JSON.stringify({ name: "Momos" }),
});
const categoryId = catRes.data.category.id;
const itemRes = await api(`/api/restaurants/${slug}/menu-items`, {
  method: "POST",
  headers: { Cookie: owner.cookie },
  body: JSON.stringify({ categoryId, name: "Chicken Momo", price: 200 }),
});
const menuItemId = itemRes.data.menuItem.id;

// ============================================================================
// 1. Concurrent payments must not jointly overpay an order.
// ============================================================================
console.log("\n-- 1. Concurrent payment race (payments route FOR UPDATE lock) --");
{
  const orderRes = await api(`/api/restaurants/${slug}/orders`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }], customerName: "Race Test 1" }),
  });
  const orderId = orderRes.data.order.id;
  const total = orderRes.data.order.totalInPaisa; // 20000 paisa (Rs 200)

  // Each request alone is valid (60% of total); together they'd overpay by 20%.
  const amountEach = Math.round(total * 0.6) / 100;
  const [r1, r2] = await Promise.all([
    api(`/api/restaurants/${slug}/orders/${orderId}/payments`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ amount: amountEach, method: "cash" }),
    }),
    api(`/api/restaurants/${slug}/orders/${orderId}/payments`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ amount: amountEach, method: "cash" }),
    }),
  ]);
  const statuses = [r1.res.status, r2.res.status].sort();
  assert(
    "exactly one of two overlapping payments succeeds (201), the other is rejected (400)",
    statuses[0] === 201 && statuses[1] === 400,
    `got statuses=${JSON.stringify(statuses)} bodies=${JSON.stringify([r1.data, r2.data])}`,
  );

  const detail = await api(`/api/restaurants/${slug}/orders/${orderId}`, { headers: { Cookie: owner.cookie } });
  assert(
    "order was NOT overpaid — net paid equals exactly one payment, not two",
    detail.data.billing.netPaidInPaisa === Math.round(amountEach * 100),
    `netPaid=${detail.data.billing.netPaidInPaisa} expected=${Math.round(amountEach * 100)}`,
  );
  assert("remaining due never went negative", detail.data.billing.remainingDueInPaisa >= 0);
}

// ============================================================================
// 2. Concurrent refunds must not jointly over-refund an order.
// ============================================================================
console.log("\n-- 2. Concurrent refund race (refunds route FOR UPDATE lock) --");
{
  const orderRes = await api(`/api/restaurants/${slug}/orders`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }], customerName: "Race Test 2" }),
  });
  const orderId = orderRes.data.order.id;
  const total = orderRes.data.order.totalInPaisa;

  // Pay in full first.
  await api(`/api/restaurants/${slug}/orders/${orderId}/payments`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ amount: total / 100, method: "cash" }),
  });

  // Two concurrent refunds, each alone valid (60% of what was paid), jointly not.
  const refundEach = Math.round(total * 0.6) / 100;
  const [r1, r2] = await Promise.all([
    api(`/api/restaurants/${slug}/orders/${orderId}/refunds`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ amount: refundEach, method: "cash" }),
    }),
    api(`/api/restaurants/${slug}/orders/${orderId}/refunds`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ amount: refundEach, method: "cash" }),
    }),
  ]);
  const statuses = [r1.res.status, r2.res.status].sort();
  assert(
    "exactly one of two overlapping refunds succeeds (201), the other is rejected (400)",
    statuses[0] === 201 && statuses[1] === 400,
    `got statuses=${JSON.stringify(statuses)} bodies=${JSON.stringify([r1.data, r2.data])}`,
  );

  const detail = await api(`/api/restaurants/${slug}/orders/${orderId}`, { headers: { Cookie: owner.cookie } });
  assert(
    "order was NOT over-refunded — net paid never went negative",
    detail.data.billing.netPaidInPaisa >= 0,
    `netPaid=${detail.data.billing.netPaidInPaisa}`,
  );
}

// ============================================================================
// 3. Concurrent order-status transitions must not double-fire side effects.
// ============================================================================
console.log("\n-- 3. Concurrent order-status race (status route compare-and-swap) --");
{
  // Seed a tracked ingredient + recipe so we can observe double-deduction.
  const supplierRes = await api(`/api/restaurants/${slug}/suppliers`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ name: "QA Supplier" }),
  });
  const supplierId = supplierRes.data.supplier?.id;
  const ingredientRes = await api(`/api/restaurants/${slug}/inventory-items`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ name: "QA Flour", unit: "g" }),
  });
  const ingredientId = ingredientRes.data.inventoryItem?.id;

  async function readStockMilliunits() {
    const list = await api(`/api/restaurants/${slug}/inventory-items`, { headers: { Cookie: owner.cookie } });
    return list.data.inventoryItems.find((i) => i.id === ingredientId)?.currentStockMilliunits;
  }

  if (!ingredientId) {
    console.log("  SKIP stock-deduction race check (could not seed inventory item —", JSON.stringify(ingredientRes.data), ")");
  } else {
    // Stock it up via a purchase so there's something to deduct (10kg, far
    // more than the tiny 0.1g/serving recipe below will ever need).
    const purchaseRes = await api(`/api/restaurants/${slug}/purchases`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({
        supplierId,
        items: [{ inventoryItemId: ingredientId, quantity: 10000, unitCost: 1 }],
      }),
    });
    assert("seed purchase recorded (201)", purchaseRes.res.status === 201, JSON.stringify(purchaseRes.data));

    // 0.1g per serving -> exactly 100 milliunits deducted per order of qty 1
    // (unitsToMilliunits rounds to the nearest milliunit) — small and exact
    // enough to make double-deduction (200) unambiguous from correct (100).
    const recipeRes = await api(`/api/restaurants/${slug}/menu-items/${menuItemId}/recipe`, {
      method: "PUT",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ items: [{ inventoryItemId: ingredientId, quantityPerServing: 0.1 }] }),
    });
    assert("recipe set (200)", recipeRes.res.status === 200, JSON.stringify(recipeRes.data));

    const stockBefore = await readStockMilliunits();

    const orderRes = await api(`/api/restaurants/${slug}/orders`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }], customerName: "Race Test 3" }),
    });
    const orderId = orderRes.data.order.id;
    await api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ status: "confirmed" }),
    });

    // Both requests read status="confirmed" and race to move to "preparing"
    // — this is exactly the transition that deducts recipe stock.
    const [r1, r2] = await Promise.all([
      api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { Cookie: owner.cookie },
        body: JSON.stringify({ status: "preparing" }),
      }),
      api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { Cookie: owner.cookie },
        body: JSON.stringify({ status: "preparing" }),
      }),
    ]);
    const statuses = [r1.res.status, r2.res.status].sort();
    assert(
      "exactly one of two overlapping status transitions succeeds (200), the other is a 409 conflict",
      statuses[0] === 200 && statuses[1] === 409,
      `got statuses=${JSON.stringify(statuses)}`,
    );

    const stockAfter = await readStockMilliunits();
    const deducted = stockBefore - stockAfter;
    assert(
      "recipe stock was deducted exactly ONCE (100 milliunits), not twice (200)",
      deducted === 100,
      `stockBefore=${stockBefore} stockAfter=${stockAfter} deducted=${deducted}`,
    );
  }
}

// ============================================================================
// 4. Concurrent gateway callback hits must not double-credit a payment.
// ============================================================================
console.log("\n-- 4. Concurrent gateway callback race (FOR UPDATE re-check) --");
{
  const orderRes = await api(`/api/restaurants/${slug}/orders`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }], customerName: "Race Test 4" }),
  });
  const orderId = orderRes.data.order.id;

  const initRes = await api(`/api/restaurants/${slug}/orders/${orderId}/payments/gateway/esewa/initiate`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
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

  // Two truly concurrent hits on the exact same callback URL — a
  // double-click on "I've paid", or the gateway redelivering the redirect.
  const [r1, r2] = await Promise.all([
    fetch(callbackUrl, { redirect: "manual" }),
    fetch(callbackUrl, { redirect: "manual" }),
  ]);
  assert(
    "both concurrent callback hits redirect successfully (both are 'success' from the caller's POV)",
    r1.status >= 300 && r1.status < 400 && r2.status >= 300 && r2.status < 400,
    `statuses=${r1.status},${r2.status}`,
  );

  const detail = await api(`/api/restaurants/${slug}/orders/${orderId}`, { headers: { Cookie: owner.cookie } });
  assert(
    "exactly ONE payment was recorded despite two concurrent callback hits",
    detail.data.order.payments.length === 1,
    `payments=${JSON.stringify(detail.data.order.payments)}`,
  );
}

// ============================================================================
// 5. Branch-scoped staff cannot change another branch's order status.
// ============================================================================
console.log("\n-- 5. Branch access on order status route --");
{
  const branchRes = await api(`/api/restaurants/${slug}/branches`, {
    method: "POST",
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ name: "QA Branch B", address: "Elsewhere", phone: "9811110071" }),
  });
  const branchBId = branchRes.data.branch?.id;

  if (!branchBId) {
    console.log("  SKIP branch access check (could not create second branch —", JSON.stringify(branchRes.data), ")");
  } else {
    const waiterPhone = `97${rand8()}`;
    const inviteRes = await api(`/api/restaurants/${slug}/staff`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({
        fullName: "QA Branch-B Waiter",
        phone: waiterPhone,
        password,
        role: "waiter",
        branchId: branchBId,
      }),
    });
    assert("branch-scoped waiter invited (201)", inviteRes.res.status === 201, JSON.stringify(inviteRes.data));

    const waiterLogin = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: waiterPhone, password }),
    });

    // An order on the restaurant's MAIN branch (not branch B).
    const orderRes = await api(`/api/restaurants/${slug}/orders`, {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }], customerName: "Race Test 5" }),
    });
    const orderId = orderRes.data.order.id;

    const patchRes = await api(`/api/restaurants/${slug}/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { Cookie: waiterLogin.cookie },
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert(
      "branch-B-scoped waiter cannot change a main-branch order's status (403)",
      patchRes.res.status === 403,
      `got ${patchRes.res.status}: ${JSON.stringify(patchRes.data)}`,
    );
  }
}

console.log(`\n== Results: ${PASS} passed, ${FAIL} failed ==`);
if (FAIL > 0) process.exit(1);
