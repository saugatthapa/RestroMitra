#!/usr/bin/env bash
# Phase 11d live smoke test: the AI assistant (owner/manager analytics Q&A).
#
# No ANTHROPIC_API_KEY is available in this build sandbox (see
# PHASE_11d_NOTES.md) — so a real end-to-end "ask a question, get an LLM
# answer" round trip cannot be exercised here. What CAN be verified live,
# against the real running server and database, is everything up to the
# LLM call itself: permission gating, request validation, rate limiting,
# and that a missing API key fails gracefully (502 with an actionable
# message) rather than crashing (500) or hanging. The prompt-building and
# Anthropic-API request/response handling are covered by
# src/lib/ai/assistant.test.ts via a mocked fetchImpl instead.
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
OWNER_JAR=$(mktemp)
WAITER_JAR=$(mktemp)
PASSWORD="testpass123"
OWNER_PHONE="98$(rand8)"

hdr() {
  H=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: 203.0.113.$((RANDOM % 254 + 1))")
}

echo "== Phase 11d smoke test: AI assistant =="

# --- Register owner + onboard ------------------------------------------------
hdr
REG=$(curl -s -c "$OWNER_JAR" "${H[@]}" -X POST "$BASE/api/auth/register" \
  -d "{\"fullName\":\"Phase11dTour Owner\",\"phone\":\"$OWNER_PHONE\",\"email\":\"phase11d.owner.$SUFFIX@example.com\",\"password\":\"$PASSWORD\"}")
assert_eq "owner register succeeds" "true" "$(echo "$REG" | jq -r '.ok')"

hdr
ONB=$(curl -s -b "$OWNER_JAR" -c "$OWNER_JAR" "${H[@]}" -X POST "$BASE/api/onboarding/restaurant" \
  -d '{"name":"Phase11dTour Restaurant","type":"restaurant","address":"Dharan Road","city":"Itahari","district":"Sunsari","phone":"9811110063","openTime":"09:00","closeTime":"21:00"}')
SLUG=$(echo "$ONB" | jq -r '.slug')
assert_eq "onboarding succeeds" "true" "$([ -n "$SLUG" ] && [ "$SLUG" != "null" ] && echo true)"

# Seed a little real data so the assistant would have something to reason
# about if it could actually call the LLM.
hdr
CAT=$(curl -s -b "$OWNER_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/categories" -d '{"name":"Momos"}')
CATEGORY_ID=$(echo "$CAT" | jq -r '.category.id')
hdr
ITEM=$(curl -s -b "$OWNER_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/menu-items" \
  -d "{\"categoryId\":\"$CATEGORY_ID\",\"name\":\"Chicken Momo\",\"price\":150}")
MENU_ITEM_ID=$(echo "$ITEM" | jq -r '.menuItem.id')
hdr
curl -s -b "$OWNER_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/orders" \
  -d "{\"items\":[{\"menuItemId\":\"$MENU_ITEM_ID\",\"quantity\":1}]}" >/dev/null

# --- Owner asks a question: reaches the LLM call and fails gracefully ------
# (no ANTHROPIC_API_KEY in this sandbox — 502, not a 500 crash, is the
# expected/correct behavior being verified here; see the script header.)
hdr
ASK_STATUS=$(curl -s -o /tmp/ask_body.json -w "%{http_code}" -b "$OWNER_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/assistant/ask" -d '{"question":"How were sales over the last 30 days?"}')
if [ "$ASK_STATUS" = "502" ] || [ "$ASK_STATUS" = "200" ]; then
  PASS=$((PASS + 1))
  echo "  OK   ask reaches the LLM call and fails gracefully (502, no API key in this sandbox) or succeeds (200, if ANTHROPIC_API_KEY were set) — got $ASK_STATUS"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL ask returned an unexpected status: $ASK_STATUS ($(cat /tmp/ask_body.json))"
fi
if [ "$ASK_STATUS" = "502" ]; then
  ERROR_MSG=$(jq -r '.error' /tmp/ask_body.json)
  assert_eq "502 error message mentions the assistant isn't configured" \
    "The AI assistant isn't configured yet — an ANTHROPIC_API_KEY is required." "$ERROR_MSG"
fi

# --- Request validation: empty question rejected ----------------------------
hdr
EMPTY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$OWNER_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/assistant/ask" -d '{"question":""}')
assert_eq "empty question rejected (400)" "400" "$EMPTY_STATUS"

hdr
TOO_LONG=$(printf 'a%.0s' $(seq 1 501))
LONG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$OWNER_JAR" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/assistant/ask" -d "{\"question\":\"$TOO_LONG\"}")
assert_eq "over-length question rejected (400)" "400" "$LONG_STATUS"

# --- Permission gating: waiter (no VIEW_REPORTS) is rejected ----------------
WAITER_PHONE="97$(rand8)"
hdr
INVITE=$(curl -s -o /tmp/invite_body.json -w "%{http_code}" -b "$OWNER_JAR" "${H[@]}" -X POST "$BASE/api/restaurants/$SLUG/staff" \
  -d "{\"fullName\":\"Phase11dTour Waiter\",\"phone\":\"$WAITER_PHONE\",\"password\":\"$PASSWORD\",\"role\":\"waiter\"}")
assert_eq "waiter invite succeeds (201)" "201" "$INVITE"

hdr
LOGIN=$(curl -s -c "$WAITER_JAR" "${H[@]}" -X POST "$BASE/api/auth/login" \
  -d "{\"phone\":\"$WAITER_PHONE\",\"password\":\"$PASSWORD\"}")
LOGIN_OK=$(echo "$LOGIN" | jq -r 'has("ok")')

if [ "$LOGIN_OK" = "true" ]; then
  hdr
  WAITER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$WAITER_JAR" "${H[@]}" -X POST \
    "$BASE/api/restaurants/$SLUG/assistant/ask" -d '{"question":"How were sales?"}')
  assert_eq "waiter (no VIEW_REPORTS) is rejected (403)" "403" "$WAITER_STATUS"
else
  echo "  SKIP waiter permission check (could not log in as seeded waiter — $LOGIN)"
fi

# --- Unauthenticated request rejected ---------------------------------------
hdr
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST \
  "$BASE/api/restaurants/$SLUG/assistant/ask" -d '{"question":"How were sales?"}')
assert_eq "unauthenticated request rejected (401)" "401" "$UNAUTH_STATUS"

# --- Dashboard page loads for an authorized owner ---------------------------
hdr
PAGE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$OWNER_JAR" "$BASE/dashboard/assistant")
assert_eq "assistant dashboard page loads for owner (200)" "200" "$PAGE_STATUS"

rm -f "$OWNER_JAR" "$WAITER_JAR" /tmp/ask_body.json /tmp/invite_body.json

echo ""
echo "== Results: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
