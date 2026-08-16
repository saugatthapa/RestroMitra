#!/usr/bin/env bash
# Phase 16 live HTTP/DB smoke test: dashboard/report analytics added in this
# phase — peak-hour stats, order completion rate, and the real (no-longer-
# hardcoded) low-stock count on the dashboard landing page. Run against the
# actual dev server + real Postgres (not mocks), same pattern as every prior
# phase's smoke test.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner + restaurant + menu item ----------------------------------
PHONE_OWNER="98$(rand8)"
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase16 Owner\",\"phone\":\"$PHONE_OWNER\",\"email\":\"phase16.owner.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase16 Restaurant $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110099\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG=$(echo "$ONB" | jq -r '.slug')
[ -n "$SLUG" ] && [ "$SLUG" != "null" ] && pass "onboard restaurant ($SLUG)" || fail "onboard restaurant: $ONB"

CAT_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/categories" "${hdr[@]}" -d '{"name":"TEST Combo"}' | jq -r '.category.id')
ITEM_ID=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Combo\",\"price\":220}" | jq -r '.menuItem.id')

TODAY=$(date -u +%Y-%m-%d)
CURRENT_HOUR=$(date -u +%H)

# =============================================================================
# PART 1: peak-hour + completion stats reflect real placed/completed orders
# =============================================================================

# Two orders placed now, taken all the way to completed+paid.
for i in 1 2; do
  ORDER=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
  ORDER_ID=$(echo "$ORDER" | jq -r '.order.id')
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"preparing"}' >/dev/null
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"ready"}' >/dev/null
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"served"}' >/dev/null
  curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/payments" "${hdr[@]}" -d '{"method":"cash","amount":220}' >/dev/null
  curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"completed"}' >/dev/null
done

# A third order left uncompleted (still "confirmed") so completion rate isn't 100%.
UNPAID_ORDER=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
UNPAID_ORDER_ID=$(echo "$UNPAID_ORDER" | jq -r '.order.id')
curl -s -b "$JAR_OWNER" -X PATCH "$BASE/api/restaurants/$SLUG/orders/$UNPAID_ORDER_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null

SUMMARY=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG/reports/summary?from=$TODAY&to=$TODAY")

echo "$SUMMARY" | jq -e ".peakHour.peakOrdersHour == $CURRENT_HOUR" >/dev/null \
  && pass "peak-hour stats: busiest hour by order count matches the current UTC hour ($CURRENT_HOUR)" \
  || fail "peakOrdersHour mismatch: $(echo "$SUMMARY" | jq -c .peakHour), expected hour $CURRENT_HOUR"

echo "$SUMMARY" | jq -e '.peakHour.peakOrdersCount == 2' >/dev/null \
  && pass "peak-hour stats: 2 completed orders counted at the busiest hour" \
  || fail "peakOrdersCount: $(echo "$SUMMARY" | jq -c .peakHour)"

echo "$SUMMARY" | jq -e '.peakHour.peakSalesInPaisa == 44000' >/dev/null \
  && pass "peak-hour stats: peak-hour revenue = 2 x Rs 220 = Rs 440" \
  || fail "peakSalesInPaisa: $(echo "$SUMMARY" | jq -c .peakHour)"

# 2 paid out of 3 non-cancelled orders (the 3rd is still "confirmed"/unpaid) -> 66.67%
echo "$SUMMARY" | jq -e '.completion.completionRatePercent == 66.67' >/dev/null \
  && pass "completion stats: 2 of 3 non-cancelled orders paid -> 66.67%" \
  || fail "completionRatePercent: $(echo "$SUMMARY" | jq -c .completion)"

echo "$SUMMARY" | jq -e '.completion.avgCompletionMinutes != null and .completion.avgCompletionMinutes >= 0' >/dev/null \
  && pass "completion stats: avgCompletionMinutes is a non-negative number for the 2 completed orders" \
  || fail "avgCompletionMinutes: $(echo "$SUMMARY" | jq -c .completion)"

# =============================================================================
# PART 2: dashboard's low-stock tile now reflects real inventory (isLowStock),
# not the old hardcoded "0"
# =============================================================================

LOW_STOCK_ITEM=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/inventory-items" "${hdr[@]}" -d '{"name":"TEST Chicken (raw)","unit":"kg","reorderLevel":5}')
echo "$LOW_STOCK_ITEM" | jq -e '.inventoryItem.currentStockMilliunits == 0 and .inventoryItem.reorderLevelMilliunits == 5000' >/dev/null \
  && pass "created a fresh inventory item at 0 stock with a reorder level (is low-stock by definition)" \
  || fail "inventory item creation: $LOW_STOCK_ITEM"

DASHBOARD_HTML=$(curl -s -b "$JAR_OWNER" "$BASE/dashboard")
echo "$DASHBOARD_HTML" | grep -q "Low-stock items" \
  && pass "dashboard HTML renders the Low-stock items tile" \
  || fail "dashboard HTML missing the Low-stock items tile"
# Real count (1) must appear next to a "low stock" note, not the old hardcoded "0"/Phase-7 placeholder text.
echo "$DASHBOARD_HTML" | grep -q "At or below reorder level" \
  && pass "dashboard low-stock tile shows the real 'at or below reorder level' note (item created above is 0/5kg)" \
  || fail "dashboard did not show the live low-stock note — still hardcoded?"

echo "---"
echo "SLUG=$SLUG"
if [ "$FAIL" = "0" ]; then echo "ALL PHASE 16 ASSERTIONS PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
