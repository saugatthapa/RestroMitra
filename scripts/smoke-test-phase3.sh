#!/usr/bin/env bash
# Phase 3 live HTTP/DB smoke test: tables + QR ordering, run against the
# actual dev server + real Postgres (not mocks). Prints PASS/FAIL per
# assertion and exits non-zero on any failure.
set -uo pipefail

BASE="http://localhost:3100"
JAR_A=$(mktemp)
JAR_B=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# Unique fake client IP per run so the in-memory, IP-keyed rate limiter
# (src/lib/rate-limit.ts) doesn't collide across repeated script runs
# within the same window — a real deployment behind a proxy that sets
# X-Forwarded-For has the same per-client separation; one that doesn't
# would bucket all traffic together, which is a known caveat, not new
# breakage from this test script.
FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")

rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Owner A: register, onboard, create table + menu -----------------------
PHONE_A="98$(rand8)"
REG_A=$(curl -s -c "$JAR_A" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Smoke Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"smoke.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}")
echo "$REG_A" | jq -e '.ok == true' >/dev/null && pass "register owner A" || { fail "register owner A: $REG_A"; }

ONB_A=$(curl -s -b "$JAR_A" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Smoke Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110000\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A slug missing: $ONB_A"

CAT=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST MOMO"}')
CAT_ID=$(echo "$CAT" | jq -r '.category.id')
[ -n "$CAT_ID" ] && [ "$CAT_ID" != "null" ] && pass "create category" || fail "create category: $CAT"

ITEM=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Buff Momo\",\"price\":180,\"taxRatePercent\":13}")
ITEM_ID=$(echo "$ITEM" | jq -r '.menuItem.id')
[ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "null" ] && pass "create menu item (Rs.180, 13% tax)" || fail "create menu item: $ITEM"

ADDON=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items/$ITEM_ID/addons" "${hdr[@]}" -d '{"name":"TEST Extra Chutney","price":20}')
ADDON_ID=$(echo "$ADDON" | jq -r '.addon.id')
[ -n "$ADDON_ID" ] && [ "$ADDON_ID" != "null" ] && pass "create addon (Rs.20)" || fail "create addon: $ADDON"

TABLE=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST Table 7","capacity":4}')
TABLE_ID=$(echo "$TABLE" | jq -r '.table.id')
QR_TOKEN=$(echo "$TABLE" | jq -r '.table.qrToken')
[ -n "$TABLE_ID" ] && [ "$TABLE_ID" != "null" ] && [ -n "$QR_TOKEN" ] && [ "$QR_TOKEN" != "null" ] && pass "create table (id=$TABLE_ID)" || fail "create table: $TABLE"

# --- QR PNG endpoint ---------------------------------------------------------
QR_CT=$(curl -s -b "$JAR_A" -o /tmp/table-qr.png -D - "$BASE/api/restaurants/$SLUG_A/tables/$TABLE_ID/qr" | grep -i '^content-type' | tr -d '\r')
QR_SIZE=$(stat -c%s /tmp/table-qr.png 2>/dev/null || echo 0)
[[ "$QR_CT" == *"image/png"* ]] && [ "$QR_SIZE" -gt 500 ] && pass "QR PNG endpoint returns a real PNG ($QR_SIZE bytes)" || fail "QR PNG endpoint: ct=$QR_CT size=$QR_SIZE"

# --- Public order page renders the menu via the token -----------------------
PAGE_HTML=$(curl -s "$BASE/order/$QR_TOKEN")
echo "$PAGE_HTML" | grep -q "TEST Smoke Restaurant A" && pass "public order page shows restaurant name" || fail "public order page missing restaurant name"
echo "$PAGE_HTML" | grep -q "TEST Table 7" && pass "public order page shows table name" || fail "public order page missing table name"

# Invalid token -> 404
INVALID_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/order/not-a-real-token-$SUFFIX")
[ "$INVALID_CODE" = "404" ] && pass "invalid QR token -> 404" || fail "invalid QR token returned $INVALID_CODE, expected 404"

# --- Submit a real order via the PUBLIC endpoint (no auth) ------------------
ORDER_BODY=$(cat <<JSON
{"items":[{"menuItemId":"$ITEM_ID","quantity":2,"addonIds":["$ADDON_ID"]}],"customerName":"TEST Customer","customerPhone":"9800000000"}
JSON
)
ORDER_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "$ORDER_BODY")
ORDER_ID=$(echo "$ORDER_RES" | jq -r '.order.id')
ORDER_TOTAL=$(echo "$ORDER_RES" | jq -r '.order.totalInPaisa')
# 2x (Rs.180 + Rs.20 addon) = 40000 paisa subtotal, 13% tax = 5200, total 45200
[ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] && pass "public order submission succeeded (id=$ORDER_ID)" || fail "public order submission: $ORDER_RES"
[ "$ORDER_TOTAL" = "45200" ] && pass "server-computed total is exactly correct (Rs. 452.00)" || fail "order total was $ORDER_TOTAL, expected 45200"

# Tampering attempt: try to smuggle a client-supplied price field — must be ignored (schema strips unknown fields; zod schema has no price field to begin with)
TAMPER_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1,\"price\":1}]}")
TAMPER_TOTAL=$(echo "$TAMPER_RES" | jq -r '.order.totalInPaisa')
# 1x Rs.180, 13% tax = 2340, total 20340 -- NOT 1 paisa
[ "$TAMPER_TOTAL" = "20340" ] && pass "client-supplied price field is ignored; server price used (Rs. 203.40)" || fail "tampered order total was $TAMPER_TOTAL, expected 20340 (price manipulation may have worked!)"

# Invalid item -> 400, not silently accepted
BAD_RES=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d '{"items":[{"menuItemId":"00000000-0000-0000-0000-000000000000","quantity":1}]}')
[ "$BAD_RES" = "400" ] && pass "nonexistent menu item id -> 400" || fail "nonexistent menu item id returned $BAD_RES, expected 400"

# Rate limiting: hammer the token endpoint past its 20/10min limit
RL_HIT=0
for i in $(seq 1 22); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$ITEM_ID\",\"quantity\":1}]}")
  if [ "$CODE" = "429" ]; then RL_HIT=1; break; fi
done
[ "$RL_HIT" = "1" ] && pass "rate limit trips after repeated submissions to the same table" || fail "rate limit never tripped after 22 rapid submissions"

# --- Owner B: cross-tenant isolation on tables -------------------------------
PHONE_B="97$(rand8)"
curl -s -c "$JAR_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Smoke Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"smoke.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Smoke Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220000\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')
[ -n "$SLUG_B" ] && [ "$SLUG_B" != "null" ] && pass "onboard restaurant B ($SLUG_B)" || fail "onboard restaurant B: $ONB_B"

CROSS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" "$BASE/api/restaurants/$SLUG_A/tables")
[ "$CROSS_CODE" = "403" ] && pass "owner B gets 403 listing owner A's tables by slug" || fail "cross-tenant table list returned $CROSS_CODE, expected 403"

CROSS_PATCH=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X PATCH "$BASE/api/restaurants/$SLUG_A/tables/$TABLE_ID" "${hdr[@]}" -d '{"name":"HIJACKED"}')
[ "$CROSS_PATCH" = "403" ] && pass "owner B gets 403 patching owner A's table" || fail "cross-tenant table patch returned $CROSS_PATCH, expected 403"

echo "---"
echo "SLUG_A=$SLUG_A SLUG_B=$SLUG_B TABLE_ID=$TABLE_ID QR_TOKEN=$QR_TOKEN ITEM_ID=$ITEM_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
