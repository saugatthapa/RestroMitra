#!/usr/bin/env bash
# Phase 5 live HTTP/DB smoke test: POS order creation + the payments/refunds
# ledger, run against the actual dev server + real Postgres (not mocks).
# Prints PASS/FAIL per assertion and exits non-zero on any failure.
#
# Note: staff management (inviting a waiter/manager account) isn't built
# until Phase 8, so this script can only drive the API as the restaurant
# owner (who holds every permission). The EDIT_ORDER-vs-REFUND_ORDER
# permission split for narrower roles (waiter/cashier/manager) is proven
# directly against the DB in
# src/db/__tests__/payments-tenant-permissions.test.ts instead, since
# there's no HTTP surface yet to create those accounts.
set -uo pipefail

BASE="http://localhost:3100"
JAR_A=$(mktemp)
JAR_B=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner A, menu, table -------------------------------------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_A" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Payments Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"payments.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_A" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Payments Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110001\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

CAT_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST MOMO"}' | jq -r '.category.id')
ITEM_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Momo\",\"price\":150}" | jq -r '.menuItem.id')
TABLE_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST Table 1"}')
TABLE_ID=$(echo "$TABLE_RES" | jq -r '.table.id')
[ -n "$CAT_ID" ] && [ "$ITEM_ID" != "null" ] && [ "$TABLE_ID" != "null" ] && pass "menu + table set up" || fail "menu/table setup failed"

# --- Second tenant, for cross-tenant checks --------------------------------
PHONE_B="97$(rand8)"
curl -s -c "$JAR_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Payments Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"payments.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Payments Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220001\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')
TABLE_B_RES=$(curl -s -b "$JAR_B" -X POST "$BASE/api/restaurants/$SLUG_B/tables" "${hdr[@]}" -d '{"name":"TEST B Table"}')
TABLE_B_ID=$(echo "$TABLE_B_RES" | jq -r '.table.id')

# --- POS order creation (staff-entered, source=pos) ------------------------
POS_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"tableId\":\"$TABLE_ID\",\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":2}],\"customerName\":\"TEST Walk-in\"}")
ORDER_ID=$(echo "$POS_RES" | jq -r '.order.id')
ORDER_TOTAL=$(echo "$POS_RES" | jq -r '.order.totalInPaisa')
ORDER_SOURCE=$(echo "$POS_RES" | jq -r '.order.source')
[ "$ORDER_SOURCE" = "pos" ] && [ "$ORDER_TOTAL" = "30000" ] && pass "POS order created: source=pos, total=Rs 300.00 (2 x Rs 150, server-computed)" || fail "POS order creation: $POS_RES"

# --- Rejects a table belonging to a different restaurant --------------------
CROSS_TABLE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"tableId\":\"$TABLE_B_ID\",\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
[ "$CROSS_TABLE_CODE" = "404" ] && pass "POS order referencing another restaurant's table -> 404" || fail "cross-tenant table id returned $CROSS_TABLE_CODE, expected 404"

# --- Order detail + billing summary -----------------------------------------
DETAIL_RES=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID")
echo "$DETAIL_RES" | jq -e '.billing.paymentStatus == "unpaid" and .billing.remainingDueInPaisa == 30000' >/dev/null \
  && pass "order detail: unpaid, remaining due = total before any payment" || fail "order detail/billing: $DETAIL_RES"

# --- Overpayment rejected ----------------------------------------------------
OVERPAY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/payments" "${hdr[@]}" -d '{"amount":500,"method":"cash"}')
[ "$OVERPAY_CODE" = "400" ] && pass "payment exceeding remaining due (Rs 500 > Rs 300) -> 400" || fail "overpayment returned $OVERPAY_CODE, expected 400"

# --- Split payment: first installment (cash) ---------------------------------
PAY1_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/payments" "${hdr[@]}" -d '{"amount":180,"method":"cash","receivedAmount":200}')
PAY1_STATUS=$(echo "$PAY1_RES" | jq -r '.billing.paymentStatus')
[ "$PAY1_STATUS" = "partially_paid" ] && pass "first split payment (Rs 180 cash) -> partially_paid" || fail "first payment: $PAY1_RES"

# --- Split payment: second installment (card), completes the bill -----------
PAY2_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/payments" "${hdr[@]}" -d '{"amount":120,"method":"card"}')
PAY2_STATUS=$(echo "$PAY2_RES" | jq -r '.billing.paymentStatus')
PAY2_DUE=$(echo "$PAY2_RES" | jq -r '.billing.remainingDueInPaisa')
[ "$PAY2_STATUS" = "paid" ] && [ "$PAY2_DUE" = "0" ] && pass "second split payment (Rs 120 card) -> paid, remaining due 0" || fail "second payment: $PAY2_RES"

# --- Any further payment on a fully-paid order is rejected -------------------
EXTRA_PAY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/payments" "${hdr[@]}" -d '{"amount":10,"method":"cash"}')
[ "$EXTRA_PAY_CODE" = "400" ] && pass "payment on a fully-paid order (remaining due = 0) -> 400" || fail "extra payment returned $EXTRA_PAY_CODE, expected 400"

# --- Partial refund -----------------------------------------------------------
REFUND_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/refunds" "${hdr[@]}" -d '{"amount":100,"method":"cash","reason":"TEST one momo was cold"}')
REFUND_STATUS=$(echo "$REFUND_RES" | jq -r '.billing.paymentStatus')
REFUND_DUE=$(echo "$REFUND_RES" | jq -r '.billing.remainingDueInPaisa')
REFUND_AMOUNT=$(echo "$REFUND_RES" | jq -r '.refund.amountInPaisa')
[ "$REFUND_STATUS" = "partially_paid" ] && [ "$REFUND_DUE" = "10000" ] && [ "$REFUND_AMOUNT" = "-10000" ] && \
  pass "partial refund (Rs 100) stored as negative amount, order back to partially_paid, due Rs 100" || fail "refund: $REFUND_RES"

# --- Refund exceeding net paid is rejected ------------------------------------
OVERREFUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/refunds" "${hdr[@]}" -d '{"amount":10000,"method":"cash"}')
[ "$OVERREFUND_CODE" = "400" ] && pass "refund exceeding net paid so far -> 400" || fail "over-refund returned $OVERREFUND_CODE, expected 400"

# --- Payment on a cancelled order is rejected ---------------------------------
POS2_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
ORDER2_ID=$(echo "$POS2_RES" | jq -r '.order.id')
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"cancelled","reason":"TEST cancelled before payment"}' >/dev/null
CANCELLED_PAY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/payments" "${hdr[@]}" -d '{"amount":150,"method":"cash"}')
[ "$CANCELLED_PAY_CODE" = "400" ] && pass "payment against a cancelled order -> 400" || fail "payment on cancelled order returned $CANCELLED_PAY_CODE, expected 400"

# --- Cross-tenant isolation on order detail / payments / refunds -------------
CROSS_DETAIL=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID")
[ "$CROSS_DETAIL" = "403" ] && pass "owner B gets 403 viewing owner A's order detail" || fail "cross-tenant order detail returned $CROSS_DETAIL, expected 403"

CROSS_PAY=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/payments" "${hdr[@]}" -d '{"amount":10,"method":"cash"}')
[ "$CROSS_PAY" = "403" ] && pass "owner B gets 403 recording a payment on owner A's order" || fail "cross-tenant payment returned $CROSS_PAY, expected 403"

CROSS_REFUND=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/refunds" "${hdr[@]}" -d '{"amount":10,"method":"cash"}')
[ "$CROSS_REFUND" = "403" ] && pass "owner B gets 403 issuing a refund on owner A's order" || fail "cross-tenant refund returned $CROSS_REFUND, expected 403"

echo "---"
echo "SLUG_A=$SLUG_A ORDER_ID=$ORDER_ID ORDER2_ID=$ORDER2_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
