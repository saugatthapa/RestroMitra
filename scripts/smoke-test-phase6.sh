#!/usr/bin/env bash
# Phase 6 live HTTP/DB smoke test: kitchen station snapshotting on order
# items + the kitchen-transition-only status route change, run against the
# actual dev server + real Postgres (not mocks). Prints PASS/FAIL per
# assertion and exits non-zero on any failure.
#
# Note: staff management (inviting a kitchen_staff/waiter account) isn't
# built until Phase 8, so this script can only drive the API as the
# restaurant owner (who holds every permission, including both EDIT_ORDER
# and UPDATE_KDS_STATUS). The kitchen_staff-vs-waiter permission split for
# narrower roles is proven directly against the DB in
# src/db/__tests__/kds-permissions.test.ts instead, since there's no HTTP
# surface yet to create those accounts.
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

# --- Setup: owner A, two kitchen stations, two menu items, a table --------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_A" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST KDS Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"kds.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_A" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST KDS Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110002\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

CAT_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST MAINS"}' | jq -r '.category.id')

GRILL_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/kitchen-stations" "${hdr[@]}" -d '{"name":"TEST Grill"}' | jq -r '.kitchenStation.id')
BAR_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/kitchen-stations" "${hdr[@]}" -d '{"name":"TEST Bar"}' | jq -r '.kitchenStation.id')
[ "$GRILL_ID" != "null" ] && [ "$BAR_ID" != "null" ] && pass "two kitchen stations created" || fail "kitchen station setup failed"

GRILL_ITEM_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"kitchenStationId\":\"$GRILL_ID\",\"name\":\"TEST Sizzler\",\"price\":300}" | jq -r '.menuItem.id')
BAR_ITEM_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"kitchenStationId\":\"$BAR_ID\",\"name\":\"TEST Lassi\",\"price\":120}" | jq -r '.menuItem.id')
[ "$GRILL_ITEM_ID" != "null" ] && [ "$BAR_ITEM_ID" != "null" ] && pass "two menu items created, each on a different station" || fail "menu item setup failed"

TABLE_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST Table 1"}')
QR_TOKEN=$(echo "$TABLE_RES" | jq -r '.table.qrToken')

# --- Place a real order spanning both stations ------------------------------
ORDER_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$GRILL_ITEM_ID\",\"quantity\":1},{\"menuItemId\":\"$BAR_ITEM_ID\",\"quantity\":2}]}")
ORDER_ID=$(echo "$ORDER_RES" | jq -r '.order.id')
[ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] && pass "placed an order spanning two stations (id=$ORDER_ID)" || fail "order placement: $ORDER_RES"

# --- Order detail shows the correct station snapshot per item ---------------
DETAIL_RES=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID")
echo "$DETAIL_RES" | jq -e --arg id "$GRILL_ITEM_ID" '.order.items[] | select(.menuItemId == $id) | .kitchenStationNameSnapshot == "TEST Grill"' >/dev/null \
  && pass "grill item snapshot shows station = TEST Grill" || fail "grill item station snapshot wrong: $DETAIL_RES"
echo "$DETAIL_RES" | jq -e --arg id "$BAR_ITEM_ID" '.order.items[] | select(.menuItemId == $id) | .kitchenStationNameSnapshot == "TEST Bar"' >/dev/null \
  && pass "bar item snapshot shows station = TEST Bar" || fail "bar item station snapshot wrong: $DETAIL_RES"

# --- Kitchen-relevant lifecycle: confirm, then the two kitchen transitions --
CONFIRM_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}')
[ "$(echo "$CONFIRM_RES" | jq -r '.order.status')" = "confirmed" ] && pass "order confirmed (front-of-house step)" || fail "confirm: $CONFIRM_RES"

PREPARING_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"preparing"}')
[ "$(echo "$PREPARING_RES" | jq -r '.order.status')" = "preparing" ] && pass "confirmed -> preparing (kitchen-driven transition)" || fail "preparing: $PREPARING_RES"

READY_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"ready"}')
[ "$(echo "$READY_RES" | jq -r '.order.status')" = "ready" ] && pass "preparing -> ready (kitchen-driven transition)" || fail "ready: $READY_RES"

# --- Illegal reverse/skip transitions are still rejected after the permission rewrite --
BACKWARD_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"preparing"}')
[ "$BACKWARD_CODE" = "400" ] && pass "ready -> preparing (backwards) still rejected with 400" || fail "backward transition returned $BACKWARD_CODE, expected 400"

# --- A second order: confirm then try to skip straight to ready -------------
ORDER2_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$GRILL_ITEM_ID\",\"quantity\":1}]}")
ORDER2_ID=$(echo "$ORDER2_RES" | jq -r '.order.id')
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
SKIP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"ready"}')
[ "$SKIP_CODE" = "400" ] && pass "confirmed -> ready (skipping preparing) still rejected with 400" || fail "skip transition returned $SKIP_CODE, expected 400"

# --- Orders list includes the new station fields on items -------------------
LIST_RES=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/orders")
echo "$LIST_RES" | jq -e --arg id "$ORDER_ID" '.orders[] | select(.id == $id) | .items | length == 2' >/dev/null \
  && pass "orders list includes both items for the multi-station order" || fail "orders list missing items: $LIST_RES"

# --- Cross-tenant isolation continues to hold on the (rewritten) status route --
PHONE_B="97$(rand8)"
curl -s -c "$JAR_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST KDS Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"kds.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
curl -s -b "$JAR_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST KDS Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220002\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}" >/dev/null

CROSS_PATCH=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER2_ID/status" "${hdr[@]}" -d '{"status":"preparing"}')
[ "$CROSS_PATCH" = "403" ] && pass "owner B gets 403 patching owner A's order status" || fail "cross-tenant status patch returned $CROSS_PATCH, expected 403"

echo "---"
echo "SLUG_A=$SLUG_A ORDER_ID=$ORDER_ID ORDER2_ID=$ORDER2_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
