#!/usr/bin/env bash
# Phase 11c live smoke test: payment gateway integrations (eSewa + Khalti).
#
# eSewa's full round trip (initiate -> signed callback -> payment recorded)
# is exercised for real against the local server + database, since eSewa's
# signature scheme is pure local HMAC-SHA256 (see esewa.ts) — no network to
# esewa.com.np is actually required for the CALLBACK half; only the
# optional server-to-server status check would need it, and that is not
# used in this flow.
#
# Khalti's initiate call requires a real network request to dev.khalti.com,
# which is blocked from this build sandbox (confirmed via curl timeouts
# during development — see PHASE_11c_NOTES.md). That half is verified via
# mocked-fetch unit tests only (khalti.test.ts); this script still exercises
# our OWN initiate route far enough to confirm it correctly reaches the
# Khalti-calling code path and fails gracefully (502) rather than crashing,
# which is the one behavior we CAN verify live from here without a real
# KHALTI_SECRET_KEY.
set -uo pipefail

BASE="http://localhost:3100"
PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  OK   $desc"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL $desc (expected [$expected], got [$actual])"
  fi
}

rand8() { echo $((10000000 + RANDOM % 89999999)); }
SUFFIX=$(cat /dev/urandom | tr -dc 'a-z0-9' | head -c 8)
COOKIE_JAR=$(mktemp)
PASSWORD="testpass123"
PHONE="98$(rand8)"

hdr() {
  H=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: 203.0.113.$((RANDOM % 254 + 1))")
}

echo "== Phase 11c smoke test: payment gateways =="

# --- Register + onboard -----------------------------------------------------
hdr
REG=$(curl -s -c "$COOKIE_JAR" "${H[@]}" -X POST "$BASE/api/auth/register" \
  -d "{\"fullName\":\"Phase11cTour Owner\",\"phone\":\"$PHONE\",\"email\":\"phase11c.owner.$SUFFIX@example.com\",\"password\":\"$PASSWORD\"}")
assert_eq "register succeeds" "true" "$(echo "$REG" | jq -r '.ok')"

hdr
ONB=$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "${H[@]}" -X POST "$BASE/api/onboarding/restaurant" \
  -d '{"name":"Phase11cTour Restaurant","type":"restaurant","address":"Dharan Road","city":"Itahari","district":"Sunsari","phone":"9811110061","openTime":"09:00","closeTime":"21:00"}')
SLUG=$(echo "$ONB" | jq -r '.slug')
assert_eq "onboarding succeeds" "true" "$([ -n "$SLUG" ] && [ "$SLUG" != "null" ] && echo true)"

hdr
CAT=$(curl -s -b "$COOKIE_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/categories" -d '{"name":"Momos"}')
CATEGORY_ID=$(echo "$CAT" | jq -r '.category.id')

hdr
ITEM=$(curl -s -b "$COOKIE_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/menu-items" \
  -d "{\"categoryId\":\"$CATEGORY_ID\",\"name\":\"Chicken Momo\",\"price\":150}")
MENU_ITEM_ID=$(echo "$ITEM" | jq -r '.menuItem.id')

hdr
ORDER=$(curl -s -b "$COOKIE_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/orders" \
  -d "{\"items\":[{\"menuItemId\":\"$MENU_ITEM_ID\",\"quantity\":1}]}")
ORDER_ID=$(echo "$ORDER" | jq -r '.order.id')
assert_eq "seed order created" "true" "$([ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] && echo true)"

# --- eSewa: initiate ---------------------------------------------------------
hdr
INIT=$(curl -s -b "$COOKIE_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/payments/gateway/esewa/initiate" -d '{}')
assert_eq "esewa initiate returns gateway=esewa" "esewa" "$(echo "$INIT" | jq -r '.gateway')"
FORM_URL=$(echo "$INIT" | jq -r '.formUrl')
assert_eq "esewa initiate returns the UAT form URL" "https://rc-epay.esewa.com.np/api/epay/main/v2/form" "$FORM_URL"
TXN_UUID=$(echo "$INIT" | jq -r '.fields.transaction_uuid')
TOTAL_AMOUNT=$(echo "$INIT" | jq -r '.fields.total_amount')
assert_eq "esewa initiate total_amount matches order (Rs. 150.00)" "150.00" "$TOTAL_AMOUNT"

# --- eSewa: build the signed callback exactly as eSewa itself would ---------
SIGNATURE=$(node -e "
const crypto = require('node:crypto');
const msg = 'total_amount=$TOTAL_AMOUNT,transaction_uuid=$TXN_UUID,product_code=EPAYTEST';
process.stdout.write(crypto.createHmac('sha256', '8gBm/:&EnhH.1/q(').update(msg).digest('base64'));
")
DATA_PARAM=$(node -e "
const payload = {
  transaction_code: '0000AB',
  status: 'COMPLETE',
  total_amount: '$TOTAL_AMOUNT',
  transaction_uuid: '$TXN_UUID',
  product_code: 'EPAYTEST',
  signed_field_names: 'total_amount,transaction_uuid,product_code',
  signature: '$SIGNATURE',
};
process.stdout.write(Buffer.from(JSON.stringify(payload)).toString('base64'));
")

CALLBACK_URL="$BASE/api/payments/gateway/esewa/callback?outcome=success&ref=$TXN_UUID&data=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$DATA_PARAM")"
CB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$CALLBACK_URL")
assert_eq "esewa callback redirects (3xx)" "307" "$CB_STATUS"
CB_LOCATION=$(curl -s -o /dev/null -D - "$CALLBACK_URL" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
assert_eq "esewa callback redirects to ?payment=success" "$BASE/dashboard/orders/$ORDER_ID?payment=success" "$CB_LOCATION"

# --- Verify the payment actually landed server-side --------------------------
hdr
DETAIL=$(curl -s -b "$COOKIE_JAR" "${H[@]}" "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID")
assert_eq "order billing shows paid" "paid" "$(echo "$DETAIL" | jq -r '.billing.paymentStatus')"
assert_eq "exactly one payment recorded" "1" "$(echo "$DETAIL" | jq '.order.payments | length')"
assert_eq "payment method is mobile_wallet" "mobile_wallet" "$(echo "$DETAIL" | jq -r '.order.payments[0].method')"

# --- Idempotent replay: hitting the callback again must not double-charge ---
curl -s -o /dev/null "$CALLBACK_URL"
hdr
DETAIL2=$(curl -s -b "$COOKIE_JAR" "${H[@]}" "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID")
assert_eq "replayed callback does not create a second payment" "1" "$(echo "$DETAIL2" | jq '.order.payments | length')"

# --- eSewa initiate on an already-paid order is rejected ---------------------
hdr
INIT2=$(curl -s -o /tmp/init2_body.json -w "%{http_code}" -b "$COOKIE_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/payments/gateway/esewa/initiate" -d '{}')
assert_eq "initiate on a fully-paid order is rejected (400)" "400" "$INIT2"

# --- Unknown gateway is rejected ---------------------------------------------
hdr
BAD_GW=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/orders/$ORDER_ID/payments/gateway/stripe/initiate" -d '{}')
assert_eq "unknown gateway param rejected (400)" "400" "$BAD_GW"

# --- Khalti: initiate reaches the Khalti-calling code and fails gracefully --
# (real network to dev.khalti.com is blocked from this build sandbox; a 502
# here — not a 500 crash — is the expected/correct behavior being verified.
# Live-verified Khalti request/response handling lives in khalti.test.ts via
# a mocked fetchImpl; see PHASE_11c_NOTES.md for the full explanation.)
hdr
ORDER2=$(curl -s -b "$COOKIE_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/orders" \
  -d "{\"items\":[{\"menuItemId\":\"$MENU_ITEM_ID\",\"quantity\":1}]}")
ORDER2_ID=$(echo "$ORDER2" | jq -r '.order.id')
hdr
KHALTI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/orders/$ORDER2_ID/payments/gateway/khalti/initiate" -d '{}')
if [ "$KHALTI_STATUS" = "502" ] || [ "$KHALTI_STATUS" = "200" ]; then
  PASS=$((PASS + 1))
  echo "  OK   khalti initiate fails gracefully (502, network blocked in this sandbox) or succeeds (200, if KHALTI_SECRET_KEY + network were available) — got $KHALTI_STATUS"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL khalti initiate returned an unexpected status: $KHALTI_STATUS"
fi

# --- Unauthenticated callback with a garbage reference doesn't crash --------
hdr
GARBAGE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/payments/gateway/esewa/callback?outcome=success&ref=not-a-real-reference")
assert_eq "callback with unknown reference redirects gracefully (307)" "307" "$GARBAGE_STATUS"

rm -f "$COOKIE_JAR" /tmp/init2_body.json

echo ""
echo "== Results: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
