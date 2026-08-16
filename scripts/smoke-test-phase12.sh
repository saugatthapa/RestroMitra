#!/usr/bin/env bash
# Phase 12 live HTTP/DB smoke test: table status + floor plan + reservation
# fix, run against the actual dev server + real Postgres (not mocks).
# Prints PASS/FAIL per assertion and exits non-zero on any failure.
#
# Covers: automatic table-status derivation from order activity, manual
# table-status transitions (staff-driven vs system-driven not fighting each
# other), out_of_service blocking new orders, floor-plan layout field
# persistence (posX/posY/width/height/shape/rotation/floorLabel), the table
# detail endpoint (active orders + upcoming reservations), reservation
# double-booking prevention (same table, overlapping window), capacity
# checks, reservation->table lifecycle effects (requested/confirmed ->
# reserved, seated -> occupied, cancelled/no_show -> released), QR ordering
# still flips table status the same as POS, and a full end-to-end chain:
# Reservation -> Table -> POS -> Order -> KDS -> Payment -> Table Available.
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

# --- Setup: owner A + restaurant A, menu, QR-capable table -----------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_A" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase12 Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"phase12.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_A" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase12 Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110099\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

CAT_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST MOMO"}' | jq -r '.category.id')
ITEM_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Momo\",\"price\":150}" | jq -r '.menuItem.id')

PHONE_B="97$(rand8)"
curl -s -c "$JAR_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase12 Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"phase12.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase12 Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220099\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')

# =============================================================================
# PART 1: table status auto-derivation from order activity
# =============================================================================

T1_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST T1","capacity":4}')
T1_ID=$(echo "$T1_RES" | jq -r '.table.id')
[ "$(echo "$T1_RES" | jq -r '.table.status')" = "available" ] && pass "new table starts 'available'" || fail "new table status: $T1_RES"

ORDER1_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"tableId\":\"$T1_ID\",\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
ORDER1_ID=$(echo "$ORDER1_RES" | jq -r '.order.id')
T1_AFTER_ORDER=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID" | jq -r '.table.status')
[ "$T1_AFTER_ORDER" = "occupied" ] && pass "table auto-flips to 'occupied' on new (pending) order" || fail "table status after order create: $T1_AFTER_ORDER"

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/status" "${hdr[@]}" -d '{"status":"preparing"}' >/dev/null
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/status" "${hdr[@]}" -d '{"status":"ready"}' >/dev/null
T1_STILL_OCCUPIED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID" | jq -r '.table.status')
[ "$T1_STILL_OCCUPIED" = "occupied" ] && pass "table stays 'occupied' through confirmed/preparing/ready" || fail "table status mid-kitchen: $T1_STILL_OCCUPIED"

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/status" "${hdr[@]}" -d '{"status":"served"}' >/dev/null
T1_SERVED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID" | jq -r '.table.status')
[ "$T1_SERVED" = "payment_pending" ] && pass "table auto-flips to 'payment_pending' once the only order is served" || fail "table status after served: $T1_SERVED"

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER1_ID/status" "${hdr[@]}" -d '{"status":"completed"}' >/dev/null
T1_COMPLETED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID" | jq -r '.table.status')
[ "$T1_COMPLETED" = "cleaning" ] && pass "table auto-flips to 'cleaning' once the order is completed" || fail "table status after completed: $T1_COMPLETED"

# Manual staff action: finish cleaning -> available
CLEAN_DONE=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID/status" "${hdr[@]}" -d '{"status":"available"}')
[ "$(echo "$CLEAN_DONE" | jq -r '.table.status')" = "available" ] && pass "staff manually finishes cleaning: cleaning -> available" || fail "manual cleaning->available: $CLEAN_DONE"

# Illegal manual jump rejected
ILLEGAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID/status" "${hdr[@]}" -d '{"status":"occupied"}')
[ "$ILLEGAL_CODE" = "400" ] && pass "manual PATCH available -> occupied rejected (system-only transition)" || fail "illegal manual transition returned $ILLEGAL_CODE, expected 400"

# =============================================================================
# PART 2: out_of_service blocks new orders, doesn't get silently cleared
# =============================================================================

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID/status" "${hdr[@]}" -d '{"status":"out_of_service"}' >/dev/null
OOS_ORDER_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"tableId\":\"$T1_ID\",\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
[ "$OOS_ORDER_CODE" = "400" ] && pass "new order against an out_of_service table -> 400" || fail "order on out_of_service table returned $OOS_ORDER_CODE, expected 400"
BACK_IN_SERVICE=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID/status" "${hdr[@]}" -d '{"status":"available"}')
[ "$(echo "$BACK_IN_SERVICE" | jq -r '.table.status')" = "available" ] && pass "table brought back into service: out_of_service -> available" || fail "restore from out_of_service: $BACK_IN_SERVICE"

# =============================================================================
# PART 3: floor-plan layout persistence
# =============================================================================

LAYOUT_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID" "${hdr[@]}" -d '{"posX":120,"posY":340,"width":150,"height":80,"shape":"circle","rotation":45,"floorLabel":"Rooftop"}')
echo "$LAYOUT_RES" | jq -e '.table.posX == 120 and .table.posY == 340 and .table.width == 150 and .table.height == 80 and .table.shape == "circle" and .table.rotation == 45 and .table.floorLabel == "Rooftop"' >/dev/null \
  && pass "floor-plan layout fields persisted (position/size/shape/rotation/floorLabel)" || fail "layout PATCH: $LAYOUT_RES"

RELOAD_RES=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID")
echo "$RELOAD_RES" | jq -e '.table.posX == 120 and .table.floorLabel == "Rooftop"' >/dev/null \
  && pass "layout fields survive a reload (GET table detail)" || fail "layout reload: $RELOAD_RES"

# =============================================================================
# PART 4: table detail endpoint (active orders + upcoming reservations)
# =============================================================================

T2_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST T2","capacity":2}')
T2_ID=$(echo "$T2_RES" | jq -r '.table.id')
ORDER2_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"tableId\":\"$T2_ID\",\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
ORDER2_ID=$(echo "$ORDER2_RES" | jq -r '.order.id')
DETAIL2=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T2_ID")
echo "$DETAIL2" | jq -e ".activeOrders | map(.id) | index(\"$ORDER2_ID\") != null" >/dev/null \
  && pass "table detail lists the active order attached to it" || fail "table detail activeOrders: $DETAIL2"

# =============================================================================
# PART 5: reservation double-booking prevention + capacity check
# =============================================================================

RESV1_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Party One\",\"customerPhone\":\"9811112222\",\"partySize\":2,\"tableId\":\"$T2_ID\",\"reservationTime\":\"2026-09-01T18:00:00.000Z\",\"durationMinutes\":90}")
RESV1_ID=$(echo "$RESV1_RES" | jq -r '.reservation.id')
[ -n "$RESV1_ID" ] && [ "$RESV1_ID" != "null" ] && pass "first reservation created for T2 at 18:00-19:30" || fail "first reservation: $RESV1_RES"

T2_RESERVED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T2_ID" | jq -r '.table.status')
# T2 was 'occupied' (from part 4's order) before this reservation, so it
# should NOT have been silently overwritten to 'reserved' -- a reservation
# only claims a table's status when it's currently available.
[ "$T2_RESERVED" = "occupied" ] && pass "reservation on an occupied table does NOT overwrite its live status" || fail "T2 status after reservation: $T2_RESERVED"

# Overlapping window on the SAME table -> 409
OVERLAP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Party Two\",\"customerPhone\":\"9811113333\",\"partySize\":2,\"tableId\":\"$T2_ID\",\"reservationTime\":\"2026-09-01T18:30:00.000Z\",\"durationMinutes\":60}")
[ "$OVERLAP_CODE" = "409" ] && pass "overlapping reservation on the same table -> 409 (double-booking prevented)" || fail "overlap check returned $OVERLAP_CODE, expected 409"

# Non-overlapping (later that night) -> succeeds
NONOVERLAP_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Party Three\",\"customerPhone\":\"9811114444\",\"partySize\":2,\"tableId\":\"$T2_ID\",\"reservationTime\":\"2026-09-01T20:00:00.000Z\",\"durationMinutes\":60}")
RESV3_ID=$(echo "$NONOVERLAP_RES" | jq -r '.reservation.id')
[ -n "$RESV3_ID" ] && [ "$RESV3_ID" != "null" ] && pass "non-overlapping reservation on the same table (later that night) succeeds" || fail "non-overlapping reservation: $NONOVERLAP_RES"

# Capacity exceeded -> 400
OVERCAP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Big Party\",\"customerPhone\":\"9811115555\",\"partySize\":9,\"tableId\":\"$T2_ID\",\"reservationTime\":\"2026-09-02T18:00:00.000Z\",\"durationMinutes\":90}")
[ "$OVERCAP_CODE" = "400" ] && pass "party size (9) exceeding table capacity (2) -> 400" || fail "capacity check returned $OVERCAP_CODE, expected 400"

# Editing a reservation's time into another reservation's window -> 409
EDIT_OVERLAP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV3_ID" "${hdr[@]}" -d '{"reservationTime":"2026-09-01T18:15:00.000Z"}')
[ "$EDIT_OVERLAP_CODE" = "409" ] && pass "editing a reservation into another one's window -> 409" || fail "edit-into-overlap returned $EDIT_OVERLAP_CODE, expected 409"

# =============================================================================
# PART 6: full end-to-end chain — Reservation -> Table -> POS -> Order -> KDS
# -> Payment -> Table Available
# =============================================================================

T3_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST T3 Chain","capacity":6}')
T3_ID=$(echo "$T3_RES" | jq -r '.table.id')
[ "$(echo "$T3_RES" | jq -r '.table.status')" = "available" ] && pass "[chain] T3 starts available" || fail "[chain] T3 initial status"

CHAIN_RESV=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Chain Party\",\"customerPhone\":\"9811116666\",\"partySize\":4,\"tableId\":\"$T3_ID\",\"reservationTime\":\"2026-09-03T19:00:00.000Z\",\"durationMinutes\":90}")
CHAIN_RESV_ID=$(echo "$CHAIN_RESV" | jq -r '.reservation.id')
T3_AFTER_RESV=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T3_ID" | jq -r '.table.status')
[ "$T3_AFTER_RESV" = "reserved" ] && pass "[chain] reservation on a free table -> table becomes 'reserved'" || fail "[chain] T3 after reservation: $T3_AFTER_RESV"

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$CHAIN_RESV_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
SEATED_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$CHAIN_RESV_ID/status" "${hdr[@]}" -d '{"status":"seated"}')
[ "$(echo "$SEATED_RES" | jq -r '.reservation.status')" = "seated" ] && pass "[chain] reservation confirmed then marked seated" || fail "[chain] seat transition: $SEATED_RES"
T3_SEATED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T3_ID" | jq -r '.table.status')
[ "$T3_SEATED" = "occupied" ] && pass "[chain] party arrives -> table becomes 'occupied'" || fail "[chain] T3 after seated: $T3_SEATED"

# POS opens the table directly (staff keys in the order from the floor plan)
CHAIN_ORDER=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders" "${hdr[@]}" -d "{\"tableId\":\"$T3_ID\",\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":4}],\"customerName\":\"TEST Chain Party\"}")
CHAIN_ORDER_ID=$(echo "$CHAIN_ORDER" | jq -r '.order.id')
CHAIN_ORDER_TOTAL=$(echo "$CHAIN_ORDER" | jq -r '.order.totalInPaisa')
[ "$CHAIN_ORDER_TOTAL" = "60000" ] && pass "[chain] POS order created from the floor plan (4 x Rs 150 = Rs 600)" || fail "[chain] order create: $CHAIN_ORDER"

# KDS flow
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$CHAIN_ORDER_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$CHAIN_ORDER_ID/status" "${hdr[@]}" -d '{"status":"preparing"}' >/dev/null
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$CHAIN_ORDER_ID/status" "${hdr[@]}" -d '{"status":"ready"}' >/dev/null
KDS_SERVED=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$CHAIN_ORDER_ID/status" "${hdr[@]}" -d '{"status":"served"}')
[ "$(echo "$KDS_SERVED" | jq -r '.order.status')" = "served" ] && pass "[chain] order advances through KDS: confirmed -> preparing -> ready -> served" || fail "[chain] KDS flow: $KDS_SERVED"

T3_SERVED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T3_ID" | jq -r '.table.status')
[ "$T3_SERVED" = "payment_pending" ] && pass "[chain] table becomes 'payment_pending' once served" || fail "[chain] T3 after served: $T3_SERVED"

# Payment: full amount in one go
CHAIN_PAY=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/orders/$CHAIN_ORDER_ID/payments" "${hdr[@]}" -d '{"amount":600,"method":"cash","receivedAmount":600}')
[ "$(echo "$CHAIN_PAY" | jq -r '.billing.paymentStatus')" = "paid" ] && pass "[chain] payment recorded in full, order marked paid" || fail "[chain] payment: $CHAIN_PAY"

# Staff closes out the order -> completed
CHAIN_COMPLETE=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$CHAIN_ORDER_ID/status" "${hdr[@]}" -d '{"status":"completed"}')
[ "$(echo "$CHAIN_COMPLETE" | jq -r '.order.status')" = "completed" ] && pass "[chain] order marked completed after payment" || fail "[chain] order completion: $CHAIN_COMPLETE"

T3_CLEANING=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T3_ID" | jq -r '.table.status')
[ "$T3_CLEANING" = "cleaning" ] && pass "[chain] table becomes 'cleaning' once the order is completed" || fail "[chain] T3 after completed: $T3_CLEANING"

# Reservation closed out too
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$CHAIN_RESV_ID/status" "${hdr[@]}" -d '{"status":"completed"}' >/dev/null

# Staff finishes cleaning -> table available again
T3_FINAL=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T3_ID/status" "${hdr[@]}" -d '{"status":"available"}')
[ "$(echo "$T3_FINAL" | jq -r '.table.status')" = "available" ] && pass "[chain] staff finishes cleaning -> table 'available' again — chain complete" || fail "[chain] final cleanup: $T3_FINAL"

# =============================================================================
# PART 7: reservation cancellation / no-show releases the table
# =============================================================================

T4_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST T4","capacity":2}')
T4_ID=$(echo "$T4_RES" | jq -r '.table.id')
RESV4=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Cancel Party\",\"customerPhone\":\"9811117777\",\"partySize\":2,\"tableId\":\"$T4_ID\",\"reservationTime\":\"2026-09-04T18:00:00.000Z\",\"durationMinutes\":60}")
RESV4_ID=$(echo "$RESV4" | jq -r '.reservation.id')
T4_RESERVED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T4_ID" | jq -r '.table.status')
[ "$T4_RESERVED" = "reserved" ] && pass "[cancel] T4 reserved" || fail "[cancel] T4 after reservation: $T4_RESERVED"

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV4_ID/status" "${hdr[@]}" -d '{"status":"cancelled"}' >/dev/null
T4_RELEASED=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T4_ID" | jq -r '.table.status')
[ "$T4_RELEASED" = "available" ] && pass "[cancel] cancelling the sole reservation releases the table back to 'available'" || fail "[cancel] T4 after cancel: $T4_RELEASED"

# =============================================================================
# PART 8: QR ordering still flips table status the same way as POS
# =============================================================================

T5_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST T5 QR"}')
T5_ID=$(echo "$T5_RES" | jq -r '.table.id')
QR_TOKEN=$(echo "$T5_RES" | jq -r '.table.qrToken')
QR_ORDER=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"customerName\":\"TEST QR Customer\"}")
[ "$(echo "$QR_ORDER" | jq -r '.order.status')" = "pending" ] && pass "QR order placed successfully (table/branch/restaurant resolved from token)" || fail "QR order: $QR_ORDER"
T5_AFTER_QR=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/tables/$T5_ID" | jq -r '.table.status')
[ "$T5_AFTER_QR" = "occupied" ] && pass "QR order flips table to 'occupied', same as a POS order" || fail "T5 status after QR order: $T5_AFTER_QR"

# =============================================================================
# PART 9: tenant isolation on the new table-status + table-detail endpoints
# =============================================================================

CROSS_STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID/status" "${hdr[@]}" -d '{"status":"out_of_service"}')
[ "$CROSS_STATUS_CODE" = "403" ] && pass "owner B gets 403 patching restaurant A's table status" || fail "cross-tenant status PATCH returned $CROSS_STATUS_CODE, expected 403"

CROSS_DETAIL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" "$BASE/api/restaurants/$SLUG_A/tables/$T1_ID")
[ "$CROSS_DETAIL_CODE" = "403" ] && pass "owner B gets 403 viewing restaurant A's table detail" || fail "cross-tenant table detail returned $CROSS_DETAIL_CODE, expected 403"

echo "---"
echo "SLUG_A=$SLUG_A T1_ID=$T1_ID T2_ID=$T2_ID T3_ID=$T3_ID CHAIN_ORDER_ID=$CHAIN_ORDER_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PHASE 12 ASSERTIONS PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
