#!/usr/bin/env bash
# Phase 9 live HTTP/DB smoke test: Analytics & Reports — run against the
# actual dev server + real Postgres (not mocks). Prints PASS/FAIL per
# assertion and exits non-zero on any failure.
#
# Covers: the VIEW_REPORTS permission split (manager/owner yes, cashier no
# — same profit-adjacent trust tier as MANAGE_EXPENSES), the summary
# endpoint's numbers matching hand-computed expectations from real orders/
# payments/expenses seeded through the actual APIs (not raw DB inserts),
# cancelled orders excluded from revenue, refund netting in the payment
# breakdown, malformed/backwards date-range query params falling back to
# the default range instead of erroring, and cross-tenant isolation.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
JAR_MANAGER=$(mktemp)
JAR_CASHIER=$(mktemp)
JAR_OWNER_B=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0
TODAY=$(date -u +%Y-%m-%d)

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner A + restaurant A, owner B + restaurant B ------------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase9Tour Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"rep.owner.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase9Tour Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110009\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

PHONE_B="96$(rand8)"
curl -s -c "$JAR_OWNER_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase9Tour Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"rep.owner.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_OWNER_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase9Tour Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220009\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')
[ -n "$SLUG_B" ] && [ "$SLUG_B" != "null" ] && pass "onboard restaurant B ($SLUG_B)" || fail "onboard restaurant B: $ONB_B"

# --- Staff: manager, cashier (for VIEW_REPORTS permission split) ------------
PHONE_MANAGER="97$(rand8)"
PHONE_CASHIER="98$(rand8)"
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"fullName\":\"TEST Phase9Tour Manager\",\"password\":\"testpass123\",\"role\":\"manager\"}" >/dev/null
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_CASHIER\",\"fullName\":\"TEST Phase9Tour Cashier\",\"password\":\"testpass123\",\"role\":\"cashier\"}" >/dev/null
curl -s -c "$JAR_MANAGER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"password\":\"testpass123\"}" >/dev/null
curl -s -c "$JAR_CASHIER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_CASHIER\",\"password\":\"testpass123\"}" >/dev/null

# --- Permission split on the summary endpoint --------------------------------
CASHIER_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_CASHIER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$CASHIER_CODE" = "403" ] && pass "cashier gets 403 on reports summary (no VIEW_REPORTS)" || fail "cashier reports summary returned $CASHIER_CODE, expected 403"

MANAGER_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$MANAGER_CODE" = "200" ] && pass "manager gets 200 on reports summary" || fail "manager reports summary returned $MANAGER_CODE, expected 200"

OWNER_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$OWNER_CODE" = "200" ] && pass "owner gets 200 on reports summary" || fail "owner reports summary returned $OWNER_CODE, expected 200"

# --- Menu + table setup -------------------------------------------------------
CAT_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST Phase9Tour MOMO"}' | jq -r '.category.id')
MOMO_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Phase9Tour Momo\",\"price\":150}" | jq -r '.menuItem.id')
DRINK_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Phase9Tour Cold Drink\",\"price\":50}" | jq -r '.menuItem.id')
[ "$MOMO_ID" != "null" ] && [ "$DRINK_ID" != "null" ] && pass "menu items created (Momo Rs 150, Cold Drink Rs 50)" || fail "menu setup failed"

# --- Order 1: 2x Momo -> completed, paid in full by cash (Rs 300) -----------
ORDER1_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$MOMO_ID\",\"quantity\":2}],\"customerName\":\"TEST Walk-in 1\"}")
ORDER1_ID=$(echo "$ORDER1_RES" | jq -r '.order.id')
[ "$(echo "$ORDER1_RES" | jq -r '.order.totalInPaisa')" = "30000" ] && pass "order 1 created: Rs 300.00 (2x Momo)" || fail "order 1 create: $ORDER1_RES"
for st in confirmed preparing ready served completed; do
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/status" "${hdr[@]}" -d "{\"status\":\"$st\"}" >/dev/null
done
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/payments" "${hdr[@]}" -d '{"amount":300,"method":"cash"}' >/dev/null

# --- Order 2: 1x Momo + 1x Cold Drink -> completed, paid by card (Rs 200) ---
ORDER2_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$MOMO_ID\",\"quantity\":1},{\"menuItemId\":\"$DRINK_ID\",\"quantity\":1}],\"customerName\":\"TEST Walk-in 2\"}")
ORDER2_ID=$(echo "$ORDER2_RES" | jq -r '.order.id')
[ "$(echo "$ORDER2_RES" | jq -r '.order.totalInPaisa')" = "20000" ] && pass "order 2 created: Rs 200.00 (1x Momo + 1x Cold Drink)" || fail "order 2 create: $ORDER2_RES"
for st in confirmed preparing ready served completed; do
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d "{\"status\":\"$st\"}" >/dev/null
done
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/payments" "${hdr[@]}" -d '{"amount":200,"method":"card"}' >/dev/null

# --- Order 3: cancelled before completion -> must NOT count as revenue ------
ORDER3_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$MOMO_ID\",\"quantity\":5}],\"customerName\":\"TEST Walk-in 3\"}")
ORDER3_ID=$(echo "$ORDER3_RES" | jq -r '.order.id')
curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER3_ID/status" "${hdr[@]}" -d '{"status":"cancelled","reason":"TEST changed mind"}' >/dev/null

# --- Expenses: rent Rs 300, supplies Rs 100 (manager-recorded) -------------
curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG_A/expenses" "${hdr[@]}" -d "{\"category\":\"rent\",\"amount\":300,\"description\":\"TEST Phase9Tour rent\",\"expenseDate\":\"$TODAY\"}" >/dev/null
curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG_A/expenses" "${hdr[@]}" -d "{\"category\":\"supplies\",\"amount\":100,\"description\":\"TEST Phase9Tour supplies\",\"expenseDate\":\"$TODAY\"}" >/dev/null

# --- Summary for exactly today: revenue, orders, AOV, expenses, net profit -
SUMMARY=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary?from=$TODAY&to=$TODAY")
echo "$SUMMARY" | jq -e '.sales.revenueInPaisa == 50000' >/dev/null && pass "revenue = Rs 500.00 (300 + 200, cancelled order excluded)" || fail "revenue wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '.sales.orderCount == 2' >/dev/null && pass "order count = 2 (completed only)" || fail "order count wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '.sales.averageOrderValueInPaisa == 25000' >/dev/null && pass "average order value = Rs 250.00" || fail "AOV wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '.sales.cancelledCount == 1' >/dev/null && pass "cancelled count = 1" || fail "cancelled count wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '.totalExpensesInPaisa == 40000' >/dev/null && pass "total expenses = Rs 400.00 (300 + 100)" || fail "total expenses wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '.netProfitInPaisa == 10000' >/dev/null && pass "net profit = Rs 100.00 (500 - 400)" || fail "net profit wrong: $SUMMARY"

# --- Top items: Momo (3 sold, Rs 450 revenue) ranks above Cold Drink -------
echo "$SUMMARY" | jq -e --arg n "TEST Phase9Tour Momo" '.topItems[0].name == $n and .topItems[0].quantitySold == 3 and .topItems[0].revenueInPaisa == 45000' >/dev/null \
  && pass "top item #1: Momo, qty 3, Rs 450.00" || fail "top item #1 wrong: $SUMMARY"
echo "$SUMMARY" | jq -e --arg n "TEST Phase9Tour Cold Drink" '.topItems[1].name == $n and .topItems[1].quantitySold == 1 and .topItems[1].revenueInPaisa == 5000' >/dev/null \
  && pass "top item #2: Cold Drink, qty 1, Rs 50.00" || fail "top item #2 wrong: $SUMMARY"

# --- Payment method breakdown: cash Rs 300, card Rs 200 ---------------------
echo "$SUMMARY" | jq -e '[.paymentBreakdown[] | select(.method == "cash")][0].totalInPaisa == 30000' >/dev/null && pass "payment breakdown: cash = Rs 300.00" || fail "cash breakdown wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '[.paymentBreakdown[] | select(.method == "card")][0].totalInPaisa == 20000' >/dev/null && pass "payment breakdown: card = Rs 200.00" || fail "card breakdown wrong: $SUMMARY"

# --- Expense category breakdown: rent Rs 300, supplies Rs 100 --------------
echo "$SUMMARY" | jq -e '[.expenseBreakdown[] | select(.category == "rent")][0].totalInPaisa == 30000' >/dev/null && pass "expense breakdown: rent = Rs 300.00" || fail "rent breakdown wrong: $SUMMARY"
echo "$SUMMARY" | jq -e '[.expenseBreakdown[] | select(.category == "supplies")][0].totalInPaisa == 10000' >/dev/null && pass "expense breakdown: supplies = Rs 100.00" || fail "supplies breakdown wrong: $SUMMARY"

# --- Daily series: today's point has both revenue and expenses -------------
echo "$SUMMARY" | jq -e --arg d "$TODAY" '[.dailySeries[] | select(.date == $d)][0] | .revenueInPaisa == 50000 and .expensesInPaisa == 40000' >/dev/null \
  && pass "daily series: today's point = Rs 500 revenue / Rs 400 expenses" || fail "daily series wrong: $SUMMARY"

# --- A partial refund on order 2's card payment nets out of the breakdown --
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/refunds" "${hdr[@]}" -d '{"amount":50,"method":"card","reason":"TEST cold drink was flat"}' >/dev/null
SUMMARY2=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary?from=$TODAY&to=$TODAY")
echo "$SUMMARY2" | jq -e '[.paymentBreakdown[] | select(.method == "card")][0].totalInPaisa == 15000' >/dev/null \
  && pass "card breakdown nets the Rs 50 refund automatically: Rs 200 - Rs 50 = Rs 150.00" || fail "card breakdown after refund wrong: $SUMMARY2"
# revenue is unaffected by a refund (revenue = completed orders' totalInPaisa, not payments received)
echo "$SUMMARY2" | jq -e '.sales.revenueInPaisa == 50000' >/dev/null && pass "revenue unaffected by refund (still Rs 500.00)" || fail "revenue after refund wrong: $SUMMARY2"

# --- Malformed / backwards date range params fall back to the default ------
BACKWARDS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary?from=$TODAY&to=2020-01-01")
[ "$BACKWARDS_CODE" = "200" ] && pass "a backwards date range doesn't error (falls back to default) -> 200" || fail "backwards range returned $BACKWARDS_CODE, expected 200"

MALFORMED_RES=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary?from=not-a-date&to=also-not-a-date")
echo "$MALFORMED_RES" | jq -e '.range.from != "not-a-date" and .range.to != "also-not-a-date"' >/dev/null \
  && pass "malformed date params fall back to the default trailing-30-day range" || fail "malformed range wrong: $MALFORMED_RES"

# --- Cross-tenant isolation ---------------------------------------------------
CROSS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$CROSS_CODE" = "403" ] && pass "owner B gets 403 on restaurant A's reports (tenant isolation)" || fail "cross-tenant reports returned $CROSS_CODE, expected 403"

SUMMARY_B=$(curl -s -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG_B/reports/summary?from=$TODAY&to=$TODAY")
echo "$SUMMARY_B" | jq -e '.sales.revenueInPaisa == 0 and .sales.orderCount == 0' >/dev/null \
  && pass "restaurant B's own summary shows zero activity (no leakage from A)" || fail "restaurant B summary wrong: $SUMMARY_B"

echo "----------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PHASE 9 ASSERTIONS PASSED"
else
  echo "SOME PHASE 9 ASSERTIONS FAILED"
fi
exit $FAIL
