#!/usr/bin/env bash
# Phase 4 live HTTP/DB smoke test: the order engine's status lifecycle, run
# against the actual dev server + real Postgres (not mocks). Prints
# PASS/FAIL per assertion and exits non-zero on any failure.
#
# Note: staff management (inviting a waiter/manager account) isn't built
# until Phase 8, so this script can only drive the API as the restaurant
# owner (who holds every permission). The EDIT_ORDER-vs-CANCEL_ORDER
# permission split for narrower roles (waiter/cashier/manager) is proven
# directly against the DB in src/db/__tests__/order-status-permissions.test.ts
# instead, since there's no HTTP surface yet to create those accounts.
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

# --- Setup: owner A, menu, table, and a real QR-placed order ----------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_A" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Orders Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"orders.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_A" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Orders Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110000\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

CAT_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST MOMO"}' | jq -r '.category.id')
ITEM_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Momo\",\"price\":150}" | jq -r '.menuItem.id')
TABLE_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST Table 1"}')
QR_TOKEN=$(echo "$TABLE_RES" | jq -r '.table.qrToken')
[ -n "$CAT_ID" ] && [ "$ITEM_ID" != "null" ] && [ "$QR_TOKEN" != "null" ] && pass "menu + table set up" || fail "menu/table setup failed"

ORDER_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
ORDER_ID=$(echo "$ORDER_RES" | jq -r '.order.id')
[ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] && pass "placed a real QR order (id=$ORDER_ID, status=pending)" || fail "order placement: $ORDER_RES"

# --- Orders list ---------------------------------------------------------
LIST_RES=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/orders")
echo "$LIST_RES" | jq -e --arg id "$ORDER_ID" '.orders[] | select(.id == $id) | .status == "pending"' >/dev/null \
  && pass "orders list shows the new order as pending" || fail "orders list missing/wrong status: $LIST_RES"

FILTERED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/orders?status=pending")
echo "$FILTERED" | jq -e --arg id "$ORDER_ID" '.orders[] | select(.id == $id)' >/dev/null \
  && pass "?status=pending filter includes the order" || fail "status filter missing the order"

# --- Illegal transition: skip straight to completed -------------------------
SKIP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"completed"}')
[ "$SKIP_CODE" = "400" ] && pass "pending -> completed (skipping stages) is rejected with 400" || fail "illegal skip-transition returned $SKIP_CODE, expected 400"

# --- Full happy-path lifecycle -----------------------------------------------
for pair in "confirmed" "preparing" "ready" "served" "completed"; do
  RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d "{\"status\":\"$pair\"}")
  GOT=$(echo "$RES" | jq -r '.order.status')
  [ "$GOT" = "$pair" ] && pass "transitioned order to \"$pair\"" || fail "transition to $pair failed: $RES"
done

# --- Terminal state: nothing transitions out of completed --------------------
POST_TERMINAL=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}')
[ "$POST_TERMINAL" = "400" ] && pass "completed order cannot be moved again (400)" || fail "post-terminal transition returned $POST_TERMINAL, expected 400"

# --- A second order, cancelled instead of completed --------------------------
ORDER2_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
ORDER2_ID=$(echo "$ORDER2_RES" | jq -r '.order.id')
CANCEL_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"cancelled","reason":"TEST customer changed mind"}')
CANCEL_STATUS=$(echo "$CANCEL_RES" | jq -r '.order.status')
[ "$CANCEL_STATUS" = "cancelled" ] && pass "second order cancelled successfully with a reason" || fail "cancel failed: $CANCEL_RES"

CANCEL_AGAIN=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}')
[ "$CANCEL_AGAIN" = "400" ] && pass "cancelled order cannot be un-cancelled (400)" || fail "post-cancel transition returned $CANCEL_AGAIN, expected 400"

# --- Nonexistent order id -> 404 ---------------------------------------------
NOTFOUND=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/00000000-0000-0000-0000-000000000000/status" "${hdr[@]}" -d '{"status":"confirmed"}')
[ "$NOTFOUND" = "404" ] && pass "nonexistent order id -> 404" || fail "nonexistent order id returned $NOTFOUND, expected 404"

# --- Cross-tenant isolation ---------------------------------------------------
PHONE_B="97$(rand8)"
curl -s -c "$JAR_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Orders Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"orders.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
curl -s -b "$JAR_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Orders Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220000\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}" >/dev/null

CROSS_LIST=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" "$BASE/api/restaurants/$SLUG_A/orders")
[ "$CROSS_LIST" = "403" ] && pass "owner B gets 403 listing owner A's orders" || fail "cross-tenant order list returned $CROSS_LIST, expected 403"

CROSS_PATCH=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}')
[ "$CROSS_PATCH" = "403" ] && pass "owner B gets 403 patching owner A's order status" || fail "cross-tenant status patch returned $CROSS_PATCH, expected 403"

echo "---"
echo "SLUG_A=$SLUG_A ORDER_ID=$ORDER_ID ORDER2_ID=$ORDER2_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
