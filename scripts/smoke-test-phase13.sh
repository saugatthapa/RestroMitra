#!/usr/bin/env bash
# Phase 13 live HTTP/DB smoke test: discounts, service charge, and tips as
# first-class order/payment concepts — run against the actual dev server +
# real Postgres (not mocks).
#
# Covers: APPLY_DISCOUNT permission gating at order-creation time (waiter
# 403, manager/owner 200), percentage vs flat discount computation, service
# charge computation, combined discount+service-charge math, the dedicated
# adjustments PATCH route (whole-state semantics, permission gating, 400 on
# a cancelled order, 400 when the new total would fall below what's already
# been collected), tip recording (doesn't affect remaining-due, appears in
# billing.tipTotalInPaisa and in the payment ledger), reports surfacing
# discountInPaisa/serviceChargeInPaisa/totalTipsInPaisa, and the newly-fixed
# branch-scoping gap on the payments/refunds routes (mirroring the QA
# hardening pass's fix on the order-status route).
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
JAR_MANAGER=$(mktemp)
JAR_WAITER=$(mktemp)
JAR_BRANCH_MGR=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner + restaurant + menu ---------------------------------------
PHONE_OWNER="98$(rand8)"
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase13 Owner\",\"phone\":\"$PHONE_OWNER\",\"email\":\"phase13.owner.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase13 Restaurant $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110099\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG=$(echo "$ONB" | jq -r '.slug')
[ -n "$SLUG" ] && [ "$SLUG" != "null" ] && pass "onboard restaurant ($SLUG)" || fail "onboard restaurant: $ONB"

CAT_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/categories" "${hdr[@]}" -d '{"name":"TEST MOMO"}' | jq -r '.category.id')
# Rs 1000.00 (no tax rate set -> taxRateBasisPoints defaults to 0), so
# subtotal math is exact and easy to assert on.
ITEM_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Combo\",\"price\":1000}" | jq -r '.menuItem.id')

# --- Staff: manager (has APPLY_DISCOUNT) + waiter (doesn't) -----------------
PHONE_MANAGER="97$(rand8)"
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"fullName\":\"TEST Manager\",\"password\":\"testpass123\",\"role\":\"manager\"}" >/dev/null
curl -s -c "$JAR_MANAGER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"password\":\"testpass123\"}" >/dev/null

PHONE_WAITER="96$(rand8)"
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"fullName\":\"TEST Waiter\",\"password\":\"testpass123\",\"role\":\"waiter\"}" >/dev/null
curl -s -c "$JAR_WAITER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_WAITER\",\"password\":\"testpass123\"}" >/dev/null

# =============================================================================
# PART 1: APPLY_DISCOUNT permission gating at order-creation time
# =============================================================================

WAITER_DISCOUNT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"adjustments\":{\"discountType\":\"percentage\",\"discountPercent\":10}}")
[ "$WAITER_DISCOUNT_CODE" = "403" ] && pass "waiter sending adjustments on order creation -> 403 (no APPLY_DISCOUNT)" || fail "waiter adjustments returned $WAITER_DISCOUNT_CODE, expected 403"

WAITER_PLAIN_ORDER=$(curl -s -b "$JAR_WAITER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
[ "$(echo "$WAITER_PLAIN_ORDER" | jq -r '.order.totalInPaisa')" = "100000" ] && pass "waiter can still place a plain order with no adjustments" || fail "waiter plain order: $WAITER_PLAIN_ORDER"

# =============================================================================
# PART 2: percentage discount, flat discount, service charge — computed at
# order creation by a permitted role (manager)
# =============================================================================

# 10% off Rs 1000 = Rs 100 off -> total Rs 900 (tax is 0 for this item)
PCT_ORDER=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"adjustments\":{\"discountType\":\"percentage\",\"discountPercent\":10,\"discountReason\":\"TEST loyalty\"}}")
PCT_ORDER_ID=$(echo "$PCT_ORDER" | jq -r '.order.id')
echo "$PCT_ORDER" | jq -e '.order.discountInPaisa == 10000 and .order.totalInPaisa == 90000 and .order.discountReason == "TEST loyalty"' >/dev/null \
  && pass "manager: 10% discount on Rs 1000 -> Rs 100 off, total Rs 900, reason stored" || fail "percentage discount order: $PCT_ORDER"

# Flat Rs 150 off Rs 1000 -> total Rs 850
FLAT_ORDER=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"adjustments\":{\"discountType\":\"flat\",\"discountFlatAmount\":150}}")
echo "$FLAT_ORDER" | jq -e '.order.discountInPaisa == 15000 and .order.totalInPaisa == 85000' >/dev/null \
  && pass "manager: flat Rs 150 discount on Rs 1000 -> total Rs 850" || fail "flat discount order: $FLAT_ORDER"

# 10% service charge on Rs 1000 -> total Rs 1100
SC_ORDER=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"adjustments\":{\"serviceChargePercent\":10}}")
echo "$SC_ORDER" | jq -e '.order.serviceChargeInPaisa == 10000 and .order.totalInPaisa == 110000' >/dev/null \
  && pass "manager: 10% service charge on Rs 1000 -> total Rs 1100" || fail "service charge order: $SC_ORDER"

# Discount + service charge together, both against the same subtotal
COMBO_ORDER=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"adjustments\":{\"discountType\":\"percentage\",\"discountPercent\":10,\"serviceChargePercent\":10}}")
echo "$COMBO_ORDER" | jq -e '.order.discountInPaisa == 10000 and .order.serviceChargeInPaisa == 10000 and .order.totalInPaisa == 100000' >/dev/null \
  && pass "manager: 10% discount + 10% service charge on Rs 1000 -> total unchanged at Rs 1000 (−100 +100)" || fail "combo order: $COMBO_ORDER"

# Malformed adjustments (percentage type but flat amount given) -> 400
MALFORMED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"adjustments\":{\"discountType\":\"percentage\",\"discountFlatAmount\":150}}")
[ "$MALFORMED_CODE" = "400" ] && pass "mismatched discountType/discountFlatAmount shape -> 400" || fail "malformed adjustments returned $MALFORMED_CODE, expected 400"

# =============================================================================
# PART 3: the dedicated adjustments PATCH route
# =============================================================================

# A plain order, no discount at creation time
PLAIN=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
PLAIN_ID=$(echo "$PLAIN" | jq -r '.order.id')
[ "$(echo "$PLAIN" | jq -r '.order.totalInPaisa')" = "100000" ] && pass "plain order created (Rs 1000, no adjustments)" || fail "plain order for PATCH test: $PLAIN"

WAITER_PATCH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_WAITER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$PLAIN_ID/adjustments" "${hdr[@]}" -d '{"discountType":"percentage","discountPercent":10}')
[ "$WAITER_PATCH_CODE" = "403" ] && pass "waiter PATCHing adjustments -> 403 (no APPLY_DISCOUNT)" || fail "waiter adjustments PATCH returned $WAITER_PATCH_CODE, expected 403"

MGR_PATCH=$(curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$PLAIN_ID/adjustments" "${hdr[@]}" -d '{"discountType":"flat","discountFlatAmount":200,"discountReason":"TEST manager comp"}')
echo "$MGR_PATCH" | jq -e '.order.discountInPaisa == 20000 and .order.totalInPaisa == 80000' >/dev/null \
  && pass "manager PATCHes a Rs 200 flat discount onto the existing order -> total Rs 800" || fail "adjustments PATCH: $MGR_PATCH"

# Whole-state semantics: PATCHing again with an EMPTY body clears the discount
CLEAR_PATCH=$(curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$PLAIN_ID/adjustments" "${hdr[@]}" -d '{}')
echo "$CLEAR_PATCH" | jq -e '.order.discountInPaisa == 0 and .order.discountType == null and .order.totalInPaisa == 100000' >/dev/null \
  && pass "PATCHing with an empty body clears the discount (whole-state, not partial-patch)" || fail "clear-adjustments PATCH: $CLEAR_PATCH"

# Re-apply, pay in full, then try to discount below what's already collected
curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$PLAIN_ID/adjustments" "${hdr[@]}" -d '{}' >/dev/null
curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders/$PLAIN_ID/payments" "${hdr[@]}" -d '{"amount":1000,"method":"cash"}' >/dev/null
OVER_DISCOUNT_RES=$(curl -s -w "\n%{http_code}" -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$PLAIN_ID/adjustments" "${hdr[@]}" -d '{"discountType":"flat","discountFlatAmount":500}')
OVER_DISCOUNT_CODE=$(echo "$OVER_DISCOUNT_RES" | tail -1)
[ "$OVER_DISCOUNT_CODE" = "400" ] && pass "discounting a fully-paid order below netPaid -> 400 (must refund first)" || fail "over-discount returned $OVER_DISCOUNT_CODE, expected 400: $OVER_DISCOUNT_RES"

# Cancelled order rejects adjustments
CANCEL_TARGET=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
CANCEL_TARGET_ID=$(echo "$CANCEL_TARGET" | jq -r '.order.id')
curl -s -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$CANCEL_TARGET_ID/status" "${hdr[@]}" -d '{"status":"cancelled"}' >/dev/null
CANCELLED_ADJ_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$CANCEL_TARGET_ID/adjustments" "${hdr[@]}" -d '{"serviceChargePercent":5}')
[ "$CANCELLED_ADJ_CODE" = "400" ] && pass "adjusting a cancelled order -> 400" || fail "cancelled-order adjustments returned $CANCELLED_ADJ_CODE, expected 400"

# =============================================================================
# PART 4: tips — additive bookkeeping, never part of the bill
# =============================================================================

TIP_ORDER=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
TIP_ORDER_ID=$(echo "$TIP_ORDER" | jq -r '.order.id')
# Pay the exact bill (Rs 1000) plus a Rs 100 tip on top
TIP_PAY=$(curl -s -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG/orders/$TIP_ORDER_ID/payments" "${hdr[@]}" -d '{"amount":1000,"method":"cash","tip":100}')
echo "$TIP_PAY" | jq -e '.payment.tipInPaisa == 10000 and .billing.remainingDueInPaisa == 0 and .billing.paymentStatus == "paid" and .billing.tipTotalInPaisa == 10000' >/dev/null \
  && pass "Rs 100 tip recorded alongside full payment: doesn't affect remainingDue, shows in tipTotalInPaisa" || fail "tip payment: $TIP_PAY"

TIP_DETAIL=$(curl -s -b "$JAR_MANAGER" "$BASE/api/restaurants/$SLUG/orders/$TIP_ORDER_ID")
echo "$TIP_DETAIL" | jq -e '.billing.tipTotalInPaisa == 10000' >/dev/null \
  && pass "order detail GET reflects the tip total too" || fail "order detail tip total: $TIP_DETAIL"

# =============================================================================
# PART 5: reports surface discounts/service charge/tips
# =============================================================================

TODAY=$(date -u +%Y-%m-%d)
REPORT=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG/reports/summary?from=$TODAY&to=$TODAY")
echo "$REPORT" | jq -e '.sales.discountInPaisa >= 0 and .sales.serviceChargeInPaisa >= 0 and .totalTipsInPaisa >= 0' >/dev/null \
  && pass "reports summary includes discountInPaisa/serviceChargeInPaisa/totalTipsInPaisa fields" || fail "reports summary shape: $REPORT"
# These orders are still 'pending' (never advanced to completed), so
# getSalesSummary (which only sums completed orders) won't count their
# discount/service-charge yet -- that's complete/pending semantics working
# as designed, not a Phase 13 regression. Just assert the tip total (scoped
# by payment.createdAt, not order status) picked up the Rs 100 tip above.
echo "$REPORT" | jq -e '.totalTipsInPaisa >= 10000' >/dev/null \
  && pass "tips summary picked up the Rs 100 tip recorded above (payment-time scoped, not order-status scoped)" || fail "tips summary missing recorded tip: $REPORT"

# =============================================================================
# PART 6: branch-scoping fix on payments/refunds routes (previously missing)
# =============================================================================

SECOND_BRANCH_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/branches" "${hdr[@]}" -d '{"name":"TEST Phase13 Second Branch","city":"Dharan"}')
SECOND_BRANCH_ID=$(echo "$SECOND_BRANCH_RES" | jq -r '.branch.id')
[ -n "$SECOND_BRANCH_ID" ] && [ "$SECOND_BRANCH_ID" != "null" ] && pass "created a second branch for the scoping test" || fail "second branch create: $SECOND_BRANCH_RES"

PHONE_BRANCH_MGR="98$(rand8)"
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_BRANCH_MGR\",\"fullName\":\"TEST Branch Manager\",\"password\":\"testpass123\",\"role\":\"manager\",\"branchId\":\"$SECOND_BRANCH_ID\"}" >/dev/null
curl -s -c "$JAR_BRANCH_MGR" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_BRANCH_MGR\",\"password\":\"testpass123\"}" >/dev/null

# An order that lives on the MAIN branch (owner/unscoped roles default there)
MAIN_BRANCH_ORDER=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
MAIN_BRANCH_ORDER_ID=$(echo "$MAIN_BRANCH_ORDER" | jq -r '.order.id')

CROSS_PAY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_BRANCH_MGR" -X POST "$BASE/api/restaurants/$SLUG/orders/$MAIN_BRANCH_ORDER_ID/payments" "${hdr[@]}" -d '{"amount":1000,"method":"cash"}')
[ "$CROSS_PAY_CODE" = "403" ] && pass "branch-scoped manager gets 403 recording a payment against a DIFFERENT branch's order (security fix verified live)" || fail "cross-branch payment returned $CROSS_PAY_CODE, expected 403"

# Owner (unrestricted) pays it so a refund attempt has something to refund
curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders/$MAIN_BRANCH_ORDER_ID/payments" "${hdr[@]}" -d '{"amount":1000,"method":"cash"}' >/dev/null
CROSS_REFUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_BRANCH_MGR" -X POST "$BASE/api/restaurants/$SLUG/orders/$MAIN_BRANCH_ORDER_ID/refunds" "${hdr[@]}" -d '{"amount":1000,"method":"cash"}')
[ "$CROSS_REFUND_CODE" = "403" ] && pass "branch-scoped manager gets 403 issuing a refund against a DIFFERENT branch's order (security fix verified live)" || fail "cross-branch refund returned $CROSS_REFUND_CODE, expected 403"

CROSS_ADJ_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_BRANCH_MGR" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$MAIN_BRANCH_ORDER_ID/adjustments" "${hdr[@]}" -d '{"serviceChargePercent":5}')
[ "$CROSS_ADJ_CODE" = "403" ] && pass "branch-scoped manager gets 403 adjusting a DIFFERENT branch's order" || fail "cross-branch adjustments returned $CROSS_ADJ_CODE, expected 403"

echo "---"
echo "SLUG=$SLUG PCT_ORDER_ID=$PCT_ORDER_ID PLAIN_ID=$PLAIN_ID TIP_ORDER_ID=$TIP_ORDER_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PHASE 13 ASSERTIONS PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
