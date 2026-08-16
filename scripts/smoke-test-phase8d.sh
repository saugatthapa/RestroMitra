#!/usr/bin/env bash
# Phase 8d live HTTP/DB smoke test: reservations — run against the actual
# dev server + real Postgres (not mocks). Prints PASS/FAIL per assertion
# and exits non-zero on any failure.
#
# Covers: the MANAGE_RESERVATIONS permission split (manager/cashier/owner
# yes, waiter no — same trust level as MANAGE_CUSTOMERS), reservation
# creation with a table link, date-scoped listing, the full status state
# machine (requested -> confirmed -> seated -> completed), illegal
# transitions rejected with 400, cancellation before seating, no_show only
# reachable from confirmed, editing booking details, and cross-tenant
# isolation.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
JAR_MANAGER=$(mktemp)
JAR_CASHIER=$(mktemp)
JAR_WAITER=$(mktemp)
JAR_OWNER_B=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner A + restaurant A, owner B + restaurant B ------------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Resv Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"resv.owner.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase8d Tour Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110009\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

PHONE_B="96$(rand8)"
curl -s -c "$JAR_OWNER_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Resv Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"resv.owner.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_OWNER_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase8d Tour Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110010\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')
[ -n "$SLUG_B" ] && [ "$SLUG_B" != "null" ] && pass "onboard restaurant B ($SLUG_B)" || fail "onboard restaurant B: $ONB_B"

# --- Staff: manager, cashier, waiter (for MANAGE_RESERVATIONS split) --------
PHONE_MANAGER="97$(rand8)"
PHONE_CASHIER="98$(rand8)"
PHONE_WAITER="96$(rand8)"

curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"fullName\":\"TEST Phase8dTour Manager\",\"password\":\"testpass123\",\"role\":\"manager\"}" >/dev/null
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_CASHIER\",\"fullName\":\"TEST Phase8dTour Cashier\",\"password\":\"testpass123\",\"role\":\"cashier\"}" >/dev/null
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"fullName\":\"TEST Phase8dTour Waiter\",\"password\":\"testpass123\",\"role\":\"waiter\"}" >/dev/null

curl -s -c "$JAR_MANAGER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"password\":\"testpass123\"}" >/dev/null
curl -s -c "$JAR_CASHIER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_CASHIER\",\"password\":\"testpass123\"}" >/dev/null
curl -s -c "$JAR_WAITER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"password\":\"testpass123\"}" >/dev/null

# --- Permission split: waiter 403, cashier/manager/owner 200 -----------------
WAITER_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" "$BASE/api/restaurants/$SLUG_A/reservations")
[ "$WAITER_LIST_CODE" = "403" ] && pass "waiter gets 403 listing reservations (no MANAGE_RESERVATIONS)" || fail "waiter reservations list returned $WAITER_LIST_CODE, expected 403"

CASHIER_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_CASHIER" "$BASE/api/restaurants/$SLUG_A/reservations")
[ "$CASHIER_LIST_CODE" = "200" ] && pass "cashier gets 200 listing reservations" || fail "cashier reservations list returned $CASHIER_LIST_CODE, expected 200"

MANAGER_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/reservations")
[ "$MANAGER_LIST_CODE" = "200" ] && pass "manager gets 200 listing reservations" || fail "manager reservations list returned $MANAGER_LIST_CODE, expected 200"

WAITER_CREATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d '{"customerName":"TEST Should Fail","customerPhone":"9812345678","partySize":2,"reservationTime":"2026-08-20T19:00:00.000Z"}')
[ "$WAITER_CREATE_CODE" = "403" ] && pass "waiter gets 403 creating a reservation" || fail "waiter reservation create returned $WAITER_CREATE_CODE, expected 403"

# --- Create a table to link -----------------------------------------------------
TABLE_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST Table 9"}')
TABLE_ID=$(echo "$TABLE_RES" | jq -r '.table.id')
[ -n "$TABLE_ID" ] && [ "$TABLE_ID" != "null" ] && pass "table created for linking" || fail "table create: $TABLE_RES"

# --- Create a reservation (as cashier), linked to the table -------------------
RESV_RES=$(curl -s -b "$JAR_CASHIER" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST Phase8dTour Party\",\"customerPhone\":\"9812345678\",\"partySize\":4,\"tableId\":\"$TABLE_ID\",\"reservationTime\":\"2026-08-20T19:00:00.000Z\",\"notes\":\"TEST birthday, need high chair\"}")
RESV_ID=$(echo "$RESV_RES" | jq -r '.reservation.id')
[ -n "$RESV_ID" ] && [ "$RESV_ID" != "null" ] && pass "reservation created, linked to table" || fail "reservation create: $RESV_RES"
[ "$(echo "$RESV_RES" | jq -r '.reservation.status')" = "requested" ] && pass "new reservation starts as 'requested'" || fail "initial status wrong: $RESV_RES"
[ "$(echo "$RESV_RES" | jq -r '.reservation.tableId')" = "$TABLE_ID" ] && pass "reservation carries the tableId" || fail "reservation missing tableId: $RESV_RES"

# --- A tableId from another restaurant is rejected with 404 -------------------
FOREIGN_TABLE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" -X POST "$BASE/api/restaurants/$SLUG_B/reservations" "${hdr[@]}" -d "{\"customerName\":\"TEST X\",\"customerPhone\":\"9812345678\",\"partySize\":2,\"tableId\":\"$TABLE_ID\",\"reservationTime\":\"2026-08-20T19:00:00.000Z\"}")
[ "$FOREIGN_TABLE_CODE" = "404" ] && pass "a tableId from another restaurant is rejected with 404" || fail "cross-tenant tableId returned $FOREIGN_TABLE_CODE, expected 404"

# --- Date-scoped listing: the reservation shows on 2026-08-20, not on a random day
LIST_ON_DATE=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/reservations?date=2026-08-20")
echo "$LIST_ON_DATE" | jq -e --arg id "$RESV_ID" '.reservations[] | select(.id == $id)' >/dev/null \
  && pass "reservation appears in the ?date=2026-08-20 listing" || fail "date-scoped list missing reservation: $LIST_ON_DATE"

LIST_OTHER_DATE=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/reservations?date=2026-08-21")
echo "$LIST_OTHER_DATE" | jq -e --arg id "$RESV_ID" '.reservations | map(select(.id == $id)) | length == 0' >/dev/null \
  && pass "reservation does NOT appear on a different date" || fail "reservation leaked into wrong date: $LIST_OTHER_DATE"

# --- Illegal transition: requested -> seated is rejected with 400 -------------
ILLEGAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV_ID/status" "${hdr[@]}" -d '{"status":"seated"}')
[ "$ILLEGAL_CODE" = "400" ] && pass "requested -> seated (skipping confirmed) is rejected with 400" || fail "illegal transition returned $ILLEGAL_CODE, expected 400"

# --- Happy path: requested -> confirmed -> seated -> completed ----------------
CONFIRM_RES=$(curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}')
[ "$(echo "$CONFIRM_RES" | jq -r '.reservation.status')" = "confirmed" ] && pass "requested -> confirmed" || fail "confirm transition: $CONFIRM_RES"

SEAT_RES=$(curl -s -b "$JAR_CASHIER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV_ID/status" "${hdr[@]}" -d '{"status":"seated"}')
[ "$(echo "$SEAT_RES" | jq -r '.reservation.status')" = "seated" ] && pass "confirmed -> seated" || fail "seat transition: $SEAT_RES"

COMPLETE_RES=$(curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV_ID/status" "${hdr[@]}" -d '{"status":"completed"}')
[ "$(echo "$COMPLETE_RES" | jq -r '.reservation.status')" = "completed" ] && pass "seated -> completed" || fail "complete transition: $COMPLETE_RES"

# --- Terminal status: completed cannot transition anywhere --------------------
TERMINAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV_ID/status" "${hdr[@]}" -d '{"status":"cancelled"}')
[ "$TERMINAL_CODE" = "400" ] && pass "completed is terminal — cannot cancel afterward" || fail "post-completion transition returned $TERMINAL_CODE, expected 400"

# --- A second reservation: cancel before seating -------------------------------
RESV2_RES=$(curl -s -b "$JAR_CASHIER" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d '{"customerName":"TEST Phase8dTour Cancel Party","customerPhone":"9812345679","partySize":2,"reservationTime":"2026-08-20T20:00:00.000Z"}')
RESV2_ID=$(echo "$RESV2_RES" | jq -r '.reservation.id')
CANCEL_RES=$(curl -s -b "$JAR_CASHIER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV2_ID/status" "${hdr[@]}" -d '{"status":"cancelled"}')
[ "$(echo "$CANCEL_RES" | jq -r '.reservation.status')" = "cancelled" ] && pass "requested -> cancelled" || fail "cancel transition: $CANCEL_RES"

# --- A third reservation: no_show only reachable from confirmed --------------
RESV3_RES=$(curl -s -b "$JAR_CASHIER" -X POST "$BASE/api/restaurants/$SLUG_A/reservations" "${hdr[@]}" -d '{"customerName":"TEST Phase8dTour NoShow Party","customerPhone":"9812345680","partySize":3,"reservationTime":"2026-08-20T21:00:00.000Z"}')
RESV3_ID=$(echo "$RESV3_RES" | jq -r '.reservation.id')

NOSHOW_TOO_EARLY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_CASHIER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV3_ID/status" "${hdr[@]}" -d '{"status":"no_show"}')
[ "$NOSHOW_TOO_EARLY_CODE" = "400" ] && pass "requested -> no_show is rejected (must be confirmed first)" || fail "premature no_show returned $NOSHOW_TOO_EARLY_CODE, expected 400"

curl -s -b "$JAR_CASHIER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV3_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
NOSHOW_RES=$(curl -s -b "$JAR_CASHIER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV3_ID/status" "${hdr[@]}" -d '{"status":"no_show"}')
[ "$(echo "$NOSHOW_RES" | jq -r '.reservation.status')" = "no_show" ] && pass "confirmed -> no_show" || fail "no_show transition: $NOSHOW_RES"

# --- Edit booking details via PATCH (not the status route) --------------------
EDIT_RES=$(curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/reservations/$RESV2_ID" "${hdr[@]}" -d '{"partySize":5,"notes":"TEST updated to a bigger party"}')
[ "$(echo "$EDIT_RES" | jq -r '.reservation.partySize')" = "5" ] && pass "reservation edited via PATCH: party size 2 -> 5" || fail "edit: $EDIT_RES"

# --- Cross-tenant isolation: owner B cannot read or edit restaurant A's data ---
CROSS_TENANT_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG_A/reservations")
[ "$CROSS_TENANT_LIST_CODE" = "403" ] && pass "owner B gets 403 listing restaurant A's reservations (tenant isolation)" || fail "cross-tenant list returned $CROSS_TENANT_LIST_CODE, expected 403"

echo "----------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PHASE 8d ASSERTIONS PASSED"
else
  echo "SOME PHASE 8d ASSERTIONS FAILED"
fi
exit $FAIL
