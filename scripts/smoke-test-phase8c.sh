#!/usr/bin/env bash
# Phase 8c live HTTP/DB smoke test: expense tracking — run against the
# actual dev server + real Postgres (not mocks). Prints PASS/FAIL per
# assertion and exits non-zero on any failure.
#
# Covers: the MANAGE_EXPENSES permission split (manager/owner yes, cashier/
# inventory_manager no — narrower than MANAGE_CUSTOMERS, since expenses are
# profit-adjacent data), expense creation with rupee->paisa conversion,
# category/date-range filtering, correcting an entry via PATCH, voiding an
# entry (and it disappearing from the default filtered view but still
# showing with ?includeVoided=true), and cross-tenant isolation.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
JAR_MANAGER=$(mktemp)
JAR_CASHIER=$(mktemp)
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
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Exp Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"exp.owner.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase8c Tour Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110007\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

PHONE_B="96$(rand8)"
curl -s -c "$JAR_OWNER_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Exp Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"exp.owner.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_OWNER_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase8c Tour Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110008\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')
[ -n "$SLUG_B" ] && [ "$SLUG_B" != "null" ] && pass "onboard restaurant B ($SLUG_B)" || fail "onboard restaurant B: $ONB_B"

# --- Staff: manager, cashier (for MANAGE_EXPENSES permission split) ----------
PHONE_MANAGER="97$(rand8)"
PHONE_CASHIER="98$(rand8)"

curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"fullName\":\"TEST Phase8cTour Manager\",\"password\":\"testpass123\",\"role\":\"manager\"}" >/dev/null
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_CASHIER\",\"fullName\":\"TEST Phase8cTour Cashier\",\"password\":\"testpass123\",\"role\":\"cashier\"}" >/dev/null

curl -s -c "$JAR_MANAGER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"password\":\"testpass123\"}" >/dev/null
curl -s -c "$JAR_CASHIER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_CASHIER\",\"password\":\"testpass123\"}" >/dev/null

# --- Permission split: cashier 403, manager/owner 200 on the expenses list --
CASHIER_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_CASHIER" "$BASE/api/restaurants/$SLUG_A/expenses")
[ "$CASHIER_LIST_CODE" = "403" ] && pass "cashier gets 403 listing expenses (no MANAGE_EXPENSES — narrower than MANAGE_CUSTOMERS)" || fail "cashier expenses list returned $CASHIER_LIST_CODE, expected 403"

MANAGER_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses")
[ "$MANAGER_LIST_CODE" = "200" ] && pass "manager gets 200 listing expenses" || fail "manager expenses list returned $MANAGER_LIST_CODE, expected 200"

OWNER_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/expenses")
[ "$OWNER_LIST_CODE" = "200" ] && pass "owner gets 200 listing expenses" || fail "owner expenses list returned $OWNER_LIST_CODE, expected 200"

# --- Cashier cannot create an expense either ----------------------------------
CASHIER_CREATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_CASHIER" -X POST "$BASE/api/restaurants/$SLUG_A/expenses" "${hdr[@]}" -d '{"category":"supplies","amount":100,"description":"TEST should fail"}')
[ "$CASHIER_CREATE_CODE" = "403" ] && pass "cashier gets 403 creating an expense" || fail "cashier expense create returned $CASHIER_CREATE_CODE, expected 403"

# --- Create three expenses across categories and dates ------------------------
RENT_RES=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG_A/expenses" "${hdr[@]}" -d '{"category":"rent","amount":25000,"description":"TEST Shrawan rent","expenseDate":"2026-08-01"}')
RENT_ID=$(echo "$RENT_RES" | jq -r '.expense.id')
[ -n "$RENT_ID" ] && [ "$RENT_ID" != "null" ] && pass "rent expense created" || fail "rent expense create: $RENT_RES"
[ "$(echo "$RENT_RES" | jq -r '.expense.amountInPaisa')" = "2500000" ] && pass "rupees->paisa conversion correct: Rs 25000.00 -> 2500000 paisa" || fail "amount conversion wrong: $RENT_RES"

UTIL_RES=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG_A/expenses" "${hdr[@]}" -d '{"category":"utilities","amount":1500,"description":"TEST electricity bill","expenseDate":"2026-08-05"}')
UTIL_ID=$(echo "$UTIL_RES" | jq -r '.expense.id')
[ -n "$UTIL_ID" ] && [ "$UTIL_ID" != "null" ] && pass "utilities expense created" || fail "utilities expense create: $UTIL_RES"

SUPPLIES_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/expenses" "${hdr[@]}" -d '{"category":"supplies","amount":800,"description":"TEST napkins and takeaway boxes","expenseDate":"2026-08-10"}')
SUPPLIES_ID=$(echo "$SUPPLIES_RES" | jq -r '.expense.id')
[ -n "$SUPPLIES_ID" ] && [ "$SUPPLIES_ID" != "null" ] && pass "supplies expense created (by owner)" || fail "supplies expense create: $SUPPLIES_RES"

# --- Full list shows all 3 -----------------------------------------------------
LIST_ALL=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses")
echo "$LIST_ALL" | jq -e '.expenses | length == 3' >/dev/null && pass "expenses list shows all 3 entries" || fail "expenses list wrong: $LIST_ALL"

# --- Category filter -----------------------------------------------------------
LIST_UTIL=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses?category=utilities")
echo "$LIST_UTIL" | jq -e '.expenses | length == 1 and .[0].category == "utilities"' >/dev/null && pass "category filter (utilities) returns exactly 1" || fail "category filter wrong: $LIST_UTIL"

# --- Date range filter ----------------------------------------------------------
LIST_RANGE=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses?from=2026-08-04&to=2026-08-06")
echo "$LIST_RANGE" | jq -e '.expenses | length == 1 and .[0].category == "utilities"' >/dev/null && pass "date range filter (Aug 4-6) returns exactly the utilities entry" || fail "date range filter wrong: $LIST_RANGE"

# --- Correct an entry via PATCH -------------------------------------------------
CORRECT_RES=$(curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/expenses/$UTIL_ID" "${hdr[@]}" -d '{"amount":1750,"note":"TEST corrected after reading the meter again"}')
[ "$(echo "$CORRECT_RES" | jq -r '.expense.amountInPaisa')" = "175000" ] && pass "expense amount corrected via PATCH: Rs 1500 -> Rs 1750" || fail "correction: $CORRECT_RES"
[ "$(echo "$CORRECT_RES" | jq -r '.expense.note')" = "TEST corrected after reading the meter again" ] && pass "correction note saved" || fail "correction note wrong: $CORRECT_RES"

# --- Cashier cannot correct an entry either -------------------------------------
CASHIER_PATCH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_CASHIER" -X PATCH "$BASE/api/restaurants/$SLUG_A/expenses/$UTIL_ID" "${hdr[@]}" -d '{"amount":1}')
[ "$CASHIER_PATCH_CODE" = "403" ] && pass "cashier gets 403 correcting an expense" || fail "cashier expense patch returned $CASHIER_PATCH_CODE, expected 403"

# --- Void an entry: disappears from the default view, stays with includeVoided -
VOID_RES=$(curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG_A/expenses/$SUPPLIES_ID" "${hdr[@]}" -d '{"isVoided":true}')
[ "$(echo "$VOID_RES" | jq -r '.expense.isVoided')" = "true" ] && pass "supplies expense voided" || fail "void: $VOID_RES"

LIST_AFTER_VOID=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses")
echo "$LIST_AFTER_VOID" | jq -e '.expenses | length == 2' >/dev/null && pass "default list excludes the voided entry (2 remain)" || fail "list after void wrong: $LIST_AFTER_VOID"

LIST_WITH_VOIDED=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses?includeVoided=true")
echo "$LIST_WITH_VOIDED" | jq -e '.expenses | length == 3' >/dev/null && pass "?includeVoided=true shows all 3, including the voided one" || fail "includeVoided list wrong: $LIST_WITH_VOIDED"

# --- A nonexistent expense id 404s on PATCH -------------------------------------
NOTFOUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG_A/expenses/00000000-0000-4000-8000-000000000000" "${hdr[@]}" -d '{"amount":1}')
[ "$NOTFOUND_CODE" = "404" ] && pass "patching a nonexistent expense id returns 404" || fail "nonexistent expense patch returned $NOTFOUND_CODE, expected 404"

# --- Cross-tenant isolation: owner B cannot read or patch restaurant A's expense
CROSS_TENANT_LIST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG_A/expenses")
[ "$CROSS_TENANT_LIST_CODE" = "403" ] && pass "owner B gets 403 listing restaurant A's expenses (tenant isolation)" || fail "cross-tenant list returned $CROSS_TENANT_LIST_CODE, expected 403"

# --- rent expense's amount was never touched: still Rs 25000 -------------------
RENT_CHECK=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG_A/expenses?category=rent")
[ "$(echo "$RENT_CHECK" | jq -r '.expenses[0].amountInPaisa')" = "2500000" ] && pass "rent expense unchanged at Rs 25000" || fail "rent expense drifted: $RENT_CHECK"

echo "----------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PHASE 8c ASSERTIONS PASSED"
else
  echo "SOME PHASE 8c ASSERTIONS FAILED"
fi
exit $FAIL
