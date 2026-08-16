#!/usr/bin/env bash
# Phase 8 live HTTP/DB smoke test: staff management + attendance, run
# against the actual dev server + real Postgres (not mocks). Prints
# PASS/FAIL per assertion and exits non-zero on any failure.
#
# Unlike every smoke test since Phase 4, this one can FINALLY drive the API
# as manager/waiter/inventory_manager accounts over real HTTP — staff
# management is what creates those accounts in the first place — closing
# the "no live HTTP coverage of the narrower role permission split" gap
# flagged in PHASE_4/5/6/7_NOTES.md.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
JAR_MANAGER=$(mktemp)
JAR_WAITER=$(mktemp)
JAR_INV=$(mktemp)
JAR_OWNER_B=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner A + restaurant ---------------------------------------------
PHONE_OWNER="98$(rand8)"
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Staff Owner A\",\"phone\":\"$PHONE_OWNER\",\"email\":\"staff.owner.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Staff Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110004\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG=$(echo "$ONB" | jq -r '.slug')
[ -n "$SLUG" ] && [ "$SLUG" != "null" ] && pass "onboard restaurant A ($SLUG)" || fail "onboard restaurant A: $ONB"

# --- Add staff: manager, waiter, inventory_manager (brand-new accounts) -----
PHONE_MANAGER="97$(rand8)"
PHONE_WAITER="96$(rand8)"
PHONE_INV="98$(rand8)"

MANAGER_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"fullName\":\"TEST Manager A\",\"password\":\"testpass123\",\"role\":\"manager\"}")
MANAGER_ROLE_ID=$(echo "$MANAGER_RES" | jq -r '.staff.id')
[ -n "$MANAGER_ROLE_ID" ] && [ "$MANAGER_ROLE_ID" != "null" ] && pass "manager added as a new account" || fail "add manager: $MANAGER_RES"

WAITER_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"fullName\":\"TEST Waiter A\",\"password\":\"testpass123\",\"role\":\"waiter\"}")
WAITER_ROLE_ID=$(echo "$WAITER_RES" | jq -r '.staff.id')
[ -n "$WAITER_ROLE_ID" ] && [ "$WAITER_ROLE_ID" != "null" ] && pass "waiter added as a new account" || fail "add waiter: $WAITER_RES"

INV_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_INV\",\"fullName\":\"TEST Inventory Manager A\",\"password\":\"testpass123\",\"role\":\"inventory_manager\"}")
INV_ROLE_ID=$(echo "$INV_RES" | jq -r '.staff.id')
[ -n "$INV_ROLE_ID" ] && [ "$INV_ROLE_ID" != "null" ] && pass "inventory_manager added as a new account" || fail "add inventory_manager: $INV_RES"

# --- Duplicate add is refused -------------------------------------------------
DUP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"role\":\"cashier\"}")
[ "$DUP_CODE" = "409" ] && pass "adding an already-active staff member again is refused with 409" || fail "duplicate add returned $DUP_CODE, expected 409"

# --- Roster lists everyone, including the owner ------------------------------
ROSTER=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG/staff")
echo "$ROSTER" | jq -e '.staff | length == 4' >/dev/null && pass "roster shows all 4 people (owner + manager + waiter + inventory_manager)" || fail "roster wrong: $ROSTER"

# --- Log in as each new staff account (proves the account is real & usable) --
curl -s -c "$JAR_MANAGER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"password\":\"testpass123\"}" >/dev/null
curl -s -c "$JAR_WAITER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"password\":\"testpass123\"}" >/dev/null
curl -s -c "$JAR_INV" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_INV\",\"password\":\"testpass123\"}" >/dev/null

WAITER_ME=$(curl -s -b "$JAR_WAITER" "$BASE/api/restaurants/$SLUG/staff" -o /dev/null -w "%{http_code}")
[ "$WAITER_ME" = "403" ] && pass "waiter gets 403 reading the staff roster (no MANAGE_STAFF)" || fail "waiter roster read returned $WAITER_ME, expected 403"

MANAGER_CAN_ADD=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"96$(rand8)\",\"fullName\":\"TEST Cashier A\",\"password\":\"testpass123\",\"role\":\"cashier\"}")
[ "$MANAGER_CAN_ADD" = "201" ] && pass "manager (holds MANAGE_STAFF by default) can add staff too" || fail "manager add-staff returned $MANAGER_CAN_ADD, expected 201"

# --- Phase 7's inventory permission split, finally testable over real HTTP --
WAITER_INV_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" "$BASE/api/restaurants/$SLUG/inventory-items")
[ "$WAITER_INV_CODE" = "403" ] && pass "waiter gets 403 on inventory-items (no MANAGE_INVENTORY) — live HTTP proof at last" || fail "waiter inventory read returned $WAITER_INV_CODE, expected 403"

INV_MANAGER_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_INV" "$BASE/api/restaurants/$SLUG/inventory-items")
[ "$INV_MANAGER_CODE" = "200" ] && pass "inventory_manager gets 200 on inventory-items — live HTTP proof at last" || fail "inventory_manager inventory read returned $INV_MANAGER_CODE, expected 200"

# --- Role escalation to owner is rejected by validation ----------------------
ESCALATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/staff/$MANAGER_ROLE_ID" "${hdr[@]}" -d '{"role":"owner"}')
[ "$ESCALATE_CODE" = "400" ] && pass "attempting to PATCH a role to 'owner' is rejected by validation with 400" || fail "role escalation returned $ESCALATE_CODE, expected 400"

# --- A manager cannot deactivate their own staff access ----------------------
SELF_DEACTIVATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/staff/$MANAGER_ROLE_ID" "${hdr[@]}" -d '{"isActive":false}')
[ "$SELF_DEACTIVATE_CODE" = "400" ] && pass "a manager cannot deactivate their own staff access (400)" || fail "self-deactivation returned $SELF_DEACTIVATE_CODE, expected 400"

# --- Attendance: clock in, double clock-in rejected, clock out, double clock-out rejected --
CLOCKIN_RES=$(curl -s -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG/attendance/clock-in" "${hdr[@]}" -d '{"note":"TEST opening shift"}')
[ "$(echo "$CLOCKIN_RES" | jq -r '.record.clockOutAt')" = "null" ] && pass "waiter clocks in, shift is open" || fail "clock-in: $CLOCKIN_RES"

DOUBLE_CLOCKIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG/attendance/clock-in" "${hdr[@]}" -d '{}')
[ "$DOUBLE_CLOCKIN_CODE" = "400" ] && pass "clocking in twice in a row is rejected with 400" || fail "double clock-in returned $DOUBLE_CLOCKIN_CODE, expected 400"

CLOCKOUT_RES=$(curl -s -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG/attendance/clock-out" "${hdr[@]}" -d '{"note":"TEST closing shift"}')
echo "$CLOCKOUT_RES" | jq -e '.record.clockOutAt != null' >/dev/null && pass "waiter clocks out, shift closed" || fail "clock-out: $CLOCKOUT_RES"
echo "$CLOCKOUT_RES" | jq -e '.record.note == "TEST opening shift / TEST closing shift"' >/dev/null \
  && pass "clock-out note is appended to the clock-in note, not overwritten" || fail "note append wrong: $CLOCKOUT_RES"

DOUBLE_CLOCKOUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG/attendance/clock-out" "${hdr[@]}" -d '{}')
[ "$DOUBLE_CLOCKOUT_CODE" = "400" ] && pass "clocking out with no open shift is rejected with 400" || fail "double clock-out returned $DOUBLE_CLOCKOUT_CODE, expected 400"

# --- Attendance visibility: self-only vs. everyone ---------------------------
WAITER_ATT=$(curl -s -b "$JAR_WAITER" "$BASE/api/restaurants/$SLUG/attendance")
[ "$(echo "$WAITER_ATT" | jq -r '.canViewAll')" = "false" ] && pass "waiter's attendance view is self-only (canViewAll=false)" || fail "waiter canViewAll wrong: $WAITER_ATT"
echo "$WAITER_ATT" | jq -e '.records | length == 1' >/dev/null && pass "waiter sees exactly their own 1 record" || fail "waiter record count wrong: $WAITER_ATT"

MANAGER_ATT=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG/attendance")
[ "$(echo "$MANAGER_ATT" | jq -r '.canViewAll')" = "true" ] && pass "manager's attendance view includes everyone (canViewAll=true)" || fail "manager canViewAll wrong: $MANAGER_ATT"
echo "$MANAGER_ATT" | jq -e --arg name "TEST Waiter A" '.records[] | select(.fullName == $name)' >/dev/null \
  && pass "manager's attendance list includes the waiter's shift" || fail "manager attendance missing waiter shift: $MANAGER_ATT"

# --- Deactivating staff revokes restaurant access -----------------------------
DEACTIVATE_RES=$(curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/staff/$WAITER_ROLE_ID" "${hdr[@]}" -d '{"isActive":false}')
[ "$(echo "$DEACTIVATE_RES" | jq -r '.staff.isActive')" = "false" ] && pass "owner deactivates the waiter" || fail "deactivate: $DEACTIVATE_RES"

REVOKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" "$BASE/api/restaurants/$SLUG/orders")
[ "$REVOKED_CODE" = "403" ] && pass "deactivated waiter gets 403 on restaurant-scoped routes even though their session cookie still works" || fail "deactivated staff access returned $REVOKED_CODE, expected 403"

# --- Cross-tenant isolation ---------------------------------------------------
PHONE_OWNER_B="97$(rand8)"
curl -s -c "$JAR_OWNER_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Staff Owner B\",\"phone\":\"$PHONE_OWNER_B\",\"email\":\"staff.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
curl -s -b "$JAR_OWNER_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Staff Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220004\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}" >/dev/null

CROSS_STAFF_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG/staff")
[ "$CROSS_STAFF_CODE" = "403" ] && pass "owner B gets 403 reading restaurant A's staff roster" || fail "cross-tenant staff read returned $CROSS_STAFF_CODE, expected 403"

CROSS_ADD_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"96$(rand8)\",\"fullName\":\"Attacker\",\"password\":\"testpass123\",\"role\":\"manager\"}")
[ "$CROSS_ADD_CODE" = "403" ] && pass "owner B gets 403 adding staff to restaurant A" || fail "cross-tenant add-staff returned $CROSS_ADD_CODE, expected 403"

echo "---"
echo "SLUG=$SLUG MANAGER_ROLE_ID=$MANAGER_ROLE_ID WAITER_ROLE_ID=$WAITER_ROLE_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
