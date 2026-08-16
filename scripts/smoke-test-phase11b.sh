#!/usr/bin/env bash
# Phase 11b live HTTP/DB smoke test: offline POS order idempotency — run
# against the actual dev server + real Postgres. Prints PASS/FAIL per
# assertion and exits non-zero on any failure.
#
# The offline queueing itself (IndexedDB, service worker, network-status
# detection) is browser-only and covered by
# scripts/screenshot-phase11b.mjs (Playwright, using context.setOffline).
# This script covers the server-side half every offline sync retry depends
# on: POSTing an order with a clientRequestId, then retrying the EXACT same
# request (as a real offline-queue sync retry would) must return the
# original order rather than create a duplicate.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }
fake_ip() { echo "203.0.113.$((RANDOM % 254 + 1))"; }
# See Phase 11a's smoke test for why this MUST be an array, never a plain
# function captured via unquoted $(...) — that word-splits header values
# containing spaces and causes curl to fire bogus extra requests.
hdr() { H=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $(fake_ip)"); }

# --- Setup: owner + restaurant + a menu item to order -----------------------
PHONE_A="98$(rand8)"
hdr; curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${H[@]}" -d "{\"fullName\":\"TEST Phase11bTour Owner\",\"phone\":\"$PHONE_A\",\"email\":\"p11b.owner.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

hdr; ONB=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${H[@]}" -d "{\"name\":\"TEST Phase11bTour Restaurant $SUFFIX\",\"type\":\"restaurant\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110050\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG=$(echo "$ONB" | jq -r '.slug')
[ -n "$SLUG" ] && [ "$SLUG" != "null" ] && pass "onboard restaurant ($SLUG)" || fail "onboard restaurant: $ONB"

hdr; CAT_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/categories" "${H[@]}" -d '{"name":"TEST Category"}')
CATEGORY_ID=$(echo "$CAT_RES" | jq -r '.category.id')

hdr; ITEM_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/menu-items" "${H[@]}" -d "{\"categoryId\":\"$CATEGORY_ID\",\"name\":\"TEST Momo\",\"price\":150}")
ITEM_ID=$(echo "$ITEM_RES" | jq -r '.menuItem.id')
[ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "null" ] && pass "menu item created" || fail "menu item create failed: $ITEM_RES"

# --- A normal order (no clientRequestId) still works unchanged --------------
hdr; PLAIN_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${H[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}],\"customerName\":\"TEST Walk-in\"}")
PLAIN_ORDER_ID=$(echo "$PLAIN_RES" | jq -r '.order.id')
[ -n "$PLAIN_ORDER_ID" ] && [ "$PLAIN_ORDER_ID" != "null" ] && pass "an order with no clientRequestId is created normally" || fail "plain order create failed: $PLAIN_RES"

# --- A clientRequestId'd order is created once, with a 201 ------------------
CRID=$(node -e "console.log(crypto.randomUUID())")
hdr; FIRST_JSON=$(curl -s -w "\n%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${H[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":2}],\"customerName\":\"TEST Offline Diner\",\"clientRequestId\":\"$CRID\"}")
FIRST_CODE=$(echo "$FIRST_JSON" | tail -n1)
FIRST_BODY=$(echo "$FIRST_JSON" | head -n-1)
FIRST_ORDER_ID=$(echo "$FIRST_BODY" | jq -r '.order.id')
[ "$FIRST_CODE" = "201" ] && pass "first submission of a clientRequestId'd order returns 201" || fail "first submission returned $FIRST_CODE, expected 201: $FIRST_BODY"
[ -n "$FIRST_ORDER_ID" ] && [ "$FIRST_ORDER_ID" != "null" ] && pass "first submission created an order ($FIRST_ORDER_ID)" || fail "first submission body wrong: $FIRST_BODY"

# --- Retrying with the SAME clientRequestId returns the SAME order, 200 -----
hdr; RETRY_JSON=$(curl -s -w "\n%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${H[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":2}],\"customerName\":\"TEST Offline Diner\",\"clientRequestId\":\"$CRID\"}")
RETRY_CODE=$(echo "$RETRY_JSON" | tail -n1)
RETRY_BODY=$(echo "$RETRY_JSON" | head -n-1)
RETRY_ORDER_ID=$(echo "$RETRY_BODY" | jq -r '.order.id')
[ "$RETRY_CODE" = "200" ] && pass "retrying the same clientRequestId returns 200, not 201" || fail "retry returned $RETRY_CODE, expected 200"
[ "$RETRY_ORDER_ID" = "$FIRST_ORDER_ID" ] && pass "the retry returns the SAME order id (no duplicate created)" || fail "retry created a different order: $FIRST_ORDER_ID vs $RETRY_ORDER_ID"
echo "$RETRY_BODY" | jq -e '.idempotentReplay == true' >/dev/null && pass "the retry response is flagged idempotentReplay: true" || fail "idempotentReplay flag missing: $RETRY_BODY"

# --- A THIRD retry (simulating another sync attempt) is still idempotent ----
hdr; THIRD_JSON=$(curl -s -w "\n%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${H[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":2}],\"customerName\":\"TEST Offline Diner\",\"clientRequestId\":\"$CRID\"}")
THIRD_ORDER_ID=$(echo "$THIRD_JSON" | head -n-1 | jq -r '.order.id')
[ "$THIRD_ORDER_ID" = "$FIRST_ORDER_ID" ] && pass "a third retry is still idempotent" || fail "third retry diverged: $THIRD_ORDER_ID"

# --- Exactly one row in the DB for this clientRequestId (not three) --------
ORDERS_LIST=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG/orders")
MATCHING_COUNT=$(echo "$ORDERS_LIST" | jq --arg id "$FIRST_ORDER_ID" '[.orders[] | select(.id == $id)] | length')
[ "$MATCHING_COUNT" = "1" ] && pass "exactly one order row exists for the retried clientRequestId" || fail "expected exactly 1 matching order, found $MATCHING_COUNT"

# --- A DIFFERENT clientRequestId for the same cart creates a SEPARATE order
CRID2=$(node -e "console.log(crypto.randomUUID())")
hdr; SEPARATE_RES=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG/orders" "${H[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":2}],\"customerName\":\"TEST Offline Diner\",\"clientRequestId\":\"$CRID2\"}")
SEPARATE_ORDER_ID=$(echo "$SEPARATE_RES" | jq -r '.order.id')
[ -n "$SEPARATE_ORDER_ID" ] && [ "$SEPARATE_ORDER_ID" != "null" ] && [ "$SEPARATE_ORDER_ID" != "$FIRST_ORDER_ID" ] \
  && pass "a different clientRequestId creates a genuinely separate order" \
  || fail "expected a new order distinct from $FIRST_ORDER_ID, got: $SEPARATE_RES"

echo "----------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PHASE 11b ASSERTIONS PASSED"
else
  echo "SOME PHASE 11b ASSERTIONS FAILED"
fi
exit $FAIL
