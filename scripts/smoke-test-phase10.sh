#!/usr/bin/env bash
# Phase 10 live HTTP/DB smoke test: SaaS plans, trials, subscriptions,
# platform admin — run against the actual dev server + real Postgres.
# Prints PASS/FAIL per assertion and exits non-zero on any failure.
#
# Covers: trial_started event logged at onboarding, the lazy self-healing
# reconciliation actually blocking a lapsed-trial restaurant with 402 over
# real HTTP, /billing staying reachable even while blocked, the dashboard
# page-level redirect to /billing for a blocked tenant, platform_admin-only
# access to /api/admin/*, the full admin subscription action set (extend
# trial, assign+activate plan, mark past due, cancel, reactivate) each
# verified against the DB afterward, the upgrade-request flow and its
# owner-only permission gate, plan-limited staff-seat enforcement, and
# cross-tenant isolation.
set -uo pipefail

BASE="http://localhost:3100"
JAR_OWNER=$(mktemp)
JAR_OWNER_B=$(mktemp)
JAR_MANAGER=$(mktemp)
JAR_ADMIN=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0
PSQL="psql postgresql://postgres:localdevpass@127.0.0.1:5432/dhankipos_dev -tA"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner A + restaurant A, owner B + restaurant B ------------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_OWNER" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase10Tour Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"p10.owner.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_OWNER" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase10Tour Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110010\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"
RESTAURANT_A_ID=$($PSQL -c "select id from restaurants where slug = '$SLUG_A'")

PHONE_B="96$(rand8)"
curl -s -c "$JAR_OWNER_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase10Tour Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"p10.owner.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ONB_B=$(curl -s -b "$JAR_OWNER_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Phase10Tour Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220010\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_B=$(echo "$ONB_B" | jq -r '.slug')
[ -n "$SLUG_B" ] && [ "$SLUG_B" != "null" ] && pass "onboard restaurant B ($SLUG_B)" || fail "onboard restaurant B: $ONB_B"

# --- A platform admin (deliberately no self-serve path -> seeded via DB) ----
PHONE_ADMIN="98$(rand8)"
curl -s -c "$JAR_ADMIN" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Phase10Tour Platform Admin\",\"phone\":\"$PHONE_ADMIN\",\"email\":\"p10.admin.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
ADMIN_USER_ID=$($PSQL -c "select id from users where phone = '$PHONE_ADMIN'")
$PSQL -c "insert into user_roles (user_id, restaurant_id, branch_id, role) values ('$ADMIN_USER_ID', null, null, 'platform_admin')" >/dev/null
# Re-login so the session reflects the freshly-granted role.
curl -s -c "$JAR_ADMIN" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_ADMIN\",\"password\":\"testpass123\"}" >/dev/null

# --- trial_started event logged at onboarding, visible via billing GET ------
BILLING_A=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/billing")
echo "$BILLING_A" | jq -e '.subscriptionStatus == "trialing"' >/dev/null && pass "restaurant A starts trialing" || fail "restaurant A status wrong: $BILLING_A"
echo "$BILLING_A" | jq -e '[.events[] | select(.eventType == "trial_started")] | length == 1' >/dev/null \
  && pass "onboarding logged exactly one trial_started event" || fail "trial_started event missing: $BILLING_A"
echo "$BILLING_A" | jq -e '.access.allowed == true and .canManageSubscription == true' >/dev/null \
  && pass "billing GET: access allowed, owner can manage subscription" || fail "billing access wrong: $BILLING_A"

# --- platform_admin-only admin routes ----------------------------------------
OWNER_ADMIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/admin/restaurants")
[ "$OWNER_ADMIN_CODE" = "403" ] && pass "a regular owner gets 403 on /api/admin/restaurants" || fail "owner admin access returned $OWNER_ADMIN_CODE, expected 403"

ADMIN_LIST=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/restaurants?q=Phase10Tour")
echo "$ADMIN_LIST" | jq -e --arg s "$SLUG_A" '[.restaurants[] | select(.slug == $s)] | length == 1' >/dev/null \
  && pass "platform admin sees restaurant A in the admin list" || fail "admin list missing restaurant A: $ADMIN_LIST"
echo "$ADMIN_LIST" | jq -e --arg s "$SLUG_B" '[.restaurants[] | select(.slug == $s)] | length == 1' >/dev/null \
  && pass "platform admin sees restaurant B in the admin list" || fail "admin list missing restaurant B: $ADMIN_LIST"

ADMIN_DETAIL_A=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/restaurants/$RESTAURANT_A_ID")
echo "$ADMIN_DETAIL_A" | jq -e --arg p "$PHONE_A" '.owner.phone == $p' >/dev/null \
  && pass "admin detail resolves restaurant A's owner correctly" || fail "admin detail owner wrong: $ADMIN_DETAIL_A"

# --- Simulate trial expiry (time passing) and confirm the lazy reconcile ----
$PSQL -c "update restaurants set trial_ends_at = now() - interval '1 day' where id = '$RESTAURANT_A_ID'" >/dev/null

BLOCKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$BLOCKED_CODE" = "402" ] && pass "a lapsed-trial restaurant gets 402 on a tenant-scoped API route" || fail "lapsed-trial route returned $BLOCKED_CODE, expected 402"

DB_STATUS_AFTER_RECONCILE=$($PSQL -c "select subscription_status from restaurants where id = '$RESTAURANT_A_ID'")
[ "$DB_STATUS_AFTER_RECONCILE" = "expired" ] && pass "the 402 write actually flipped restaurants.subscription_status to expired" || fail "DB status after reconcile: $DB_STATUS_AFTER_RECONCILE"

BILLING_BLOCKED=$(curl -s -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/billing")
echo "$BILLING_BLOCKED" | jq -e '.access.allowed == false and .access.reason == "expired"' >/dev/null \
  && pass "billing GET stays reachable while blocked, and reports allowed:false" || fail "blocked billing GET wrong: $BILLING_BLOCKED"

# --- The dashboard page itself redirects a blocked tenant to /billing -------
DASH_REDIRECT=$(curl -s -D - -o /dev/null -b "$JAR_OWNER" "$BASE/dashboard")
echo "$DASH_REDIRECT" | grep -qi "location: /billing" && pass "GET /dashboard redirects a blocked tenant to /billing" \
  || fail "dashboard redirect header missing/wrong:\n$DASH_REDIRECT"

# --- Admin action: extend_trial un-expires the restaurant --------------------
EXTEND_RES=$(curl -s -b "$JAR_ADMIN" -X PATCH "$BASE/api/admin/restaurants/$RESTAURANT_A_ID/subscription" "${hdr[@]}" -d '{"action":"extend_trial","days":30,"note":"TEST goodwill extension"}')
echo "$EXTEND_RES" | jq -e '.restaurant.subscriptionStatus == "trialing"' >/dev/null \
  && pass "extend_trial un-expires the restaurant back to trialing" || fail "extend_trial response wrong: $EXTEND_RES"

RESTORED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$RESTORED_CODE" = "200" ] && pass "after extend_trial, the tenant route is reachable again (200)" || fail "restored route returned $RESTORED_CODE, expected 200"

# --- Admin action: assign_plan + activate -------------------------------------
ASSIGN_RES=$(curl -s -b "$JAR_ADMIN" -X PATCH "$BASE/api/admin/restaurants/$RESTAURANT_A_ID/subscription" "${hdr[@]}" -d '{"action":"assign_plan","planKey":"starter","activate":true,"note":"TEST assigning starter"}')
echo "$ASSIGN_RES" | jq -e '.restaurant.subscriptionStatus == "active" and .restaurant.planKey == "starter"' >/dev/null \
  && pass "assign_plan+activate sets status active and planKey starter" || fail "assign_plan response wrong: $ASSIGN_RES"

# --- Staff-seat plan-limit enforcement (starter = 5 non-owner staff max) ----
STAFF_OK=1
for i in 1 2 3 4 5; do
  ROLE="cashier"
  [ "$i" = "1" ] && ROLE="manager"
  PHONE_STAFF="97$(rand8)"
  RES=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d "{\"phone\":\"$PHONE_STAFF\",\"fullName\":\"TEST Phase10Tour Staff $i\",\"password\":\"testpass123\",\"role\":\"$ROLE\"}")
  [ "$RES" = "201" ] || STAFF_OK=0
  [ "$i" = "1" ] && PHONE_MANAGER="$PHONE_STAFF"
done
[ "$STAFF_OK" = "1" ] && pass "starter plan allows exactly 5 non-owner staff" || fail "one of the first 5 staff invites failed unexpectedly"

SIXTH_RES=$(curl -s -w "\n%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/staff" "${hdr[@]}" -d '{"phone":"9799999999","fullName":"TEST Phase10Tour Staff 6","password":"testpass123","role":"cashier"}')
SIXTH_CODE=$(echo "$SIXTH_RES" | tail -n1)
SIXTH_BODY=$(echo "$SIXTH_RES" | head -n-1)
[ "$SIXTH_CODE" = "403" ] && pass "the 6th staff invite is rejected (403) — starter plan's staff limit" || fail "6th staff invite returned $SIXTH_CODE, expected 403"
echo "$SIXTH_BODY" | jq -e '.error | test("staff limit")' >/dev/null && pass "6th invite's error message explains the plan limit" || fail "6th invite error message wrong: $SIXTH_BODY"

curl -s -c "$JAR_MANAGER" -X POST "$BASE/api/auth/login" "${hdr[@]}" -d "{\"phone\":\"$PHONE_MANAGER\",\"password\":\"testpass123\"}" >/dev/null

# --- upgrade-request: owner-only, logs an event, does not itself change state
UPGRADE_RES=$(curl -s -w "\n%{http_code}" -b "$JAR_OWNER" -X POST "$BASE/api/restaurants/$SLUG_A/billing/upgrade-request" "${hdr[@]}" -d '{"planKey":"pro","note":"TEST outgrowing starter"}')
UPGRADE_CODE=$(echo "$UPGRADE_RES" | tail -n1)
[ "$UPGRADE_CODE" = "201" ] && pass "owner can submit an upgrade-request (201)" || fail "owner upgrade-request returned $UPGRADE_CODE, expected 201"

MANAGER_UPGRADE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_MANAGER" -X POST "$BASE/api/restaurants/$SLUG_A/billing/upgrade-request" "${hdr[@]}" -d '{"planKey":"pro"}')
[ "$MANAGER_UPGRADE_CODE" = "403" ] && pass "a manager is denied MANAGE_SUBSCRIPTION on upgrade-request (403)" || fail "manager upgrade-request returned $MANAGER_UPGRADE_CODE, expected 403"

STILL_STARTER=$($PSQL -c "select plan_key from restaurants where id = '$RESTAURANT_A_ID'")
[ "$STILL_STARTER" = "starter" ] && pass "upgrade-request alone did not change the actual plan (still starter, pending admin action)" || fail "plan changed unexpectedly to: $STILL_STARTER"

ADMIN_DETAIL_AFTER_UPGRADE=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/restaurants/$RESTAURANT_A_ID")
echo "$ADMIN_DETAIL_AFTER_UPGRADE" | jq -e '[.events[] | select(.eventType == "upgrade_requested")] | length == 1' >/dev/null \
  && pass "admin detail shows the upgrade_requested event in the timeline" || fail "upgrade_requested event missing: $ADMIN_DETAIL_AFTER_UPGRADE"

# --- Admin action: mark_past_due is a grace period, still allowed ------------
curl -s -b "$JAR_ADMIN" -X PATCH "$BASE/api/admin/restaurants/$RESTAURANT_A_ID/subscription" "${hdr[@]}" -d '{"action":"mark_past_due"}' >/dev/null
PAST_DUE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$PAST_DUE_CODE" = "200" ] && pass "past_due is a grace period — tenant route still 200" || fail "past_due route returned $PAST_DUE_CODE, expected 200"

# --- Admin action: cancel blocks access, and the dashboard redirects again --
curl -s -b "$JAR_ADMIN" -X PATCH "$BASE/api/admin/restaurants/$RESTAURANT_A_ID/subscription" "${hdr[@]}" -d '{"action":"cancel","note":"TEST cancelling"}' >/dev/null
CANCELLED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$CANCELLED_CODE" = "402" ] && pass "cancelled restaurant gets 402 on tenant-scoped routes" || fail "cancelled route returned $CANCELLED_CODE, expected 402"

CANCEL_DASH_REDIRECT=$(curl -s -D - -o /dev/null -b "$JAR_OWNER" "$BASE/dashboard")
echo "$CANCEL_DASH_REDIRECT" | grep -qi "location: /billing" && pass "cancelled tenant is redirected to /billing again" \
  || fail "cancel dashboard redirect header missing/wrong:\n$CANCEL_DASH_REDIRECT"

# --- Admin action: reactivate restores access ---------------------------------
curl -s -b "$JAR_ADMIN" -X PATCH "$BASE/api/admin/restaurants/$RESTAURANT_A_ID/subscription" "${hdr[@]}" -d '{"action":"reactivate"}' >/dev/null
REACTIVATED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER" "$BASE/api/restaurants/$SLUG_A/reports/summary")
[ "$REACTIVATED_CODE" = "200" ] && pass "reactivate restores access (200)" || fail "reactivated route returned $REACTIVATED_CODE, expected 200"

# --- platform_admin can always reach a tenant's data, cancelled or not -------
$PSQL -c "update restaurants set subscription_status = 'cancelled' where id = '$RESTAURANT_A_ID'" >/dev/null
ADMIN_STILL_SEES=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_ADMIN" "$BASE/api/admin/restaurants/$RESTAURANT_A_ID")
[ "$ADMIN_STILL_SEES" = "200" ] && pass "platform admin can still fetch a cancelled tenant's detail (200)" || fail "admin detail on cancelled tenant returned $ADMIN_STILL_SEES"
curl -s -b "$JAR_ADMIN" -X PATCH "$BASE/api/admin/restaurants/$RESTAURANT_A_ID/subscription" "${hdr[@]}" -d '{"action":"reactivate","note":"TEST restoring for cleanup"}' >/dev/null

# --- Cross-tenant isolation ----------------------------------------------------
CROSS_BILLING_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG_A/billing")
[ "$CROSS_BILLING_CODE" = "403" ] && pass "owner B gets 403 on restaurant A's billing (tenant isolation)" || fail "cross-tenant billing returned $CROSS_BILLING_CODE, expected 403"

BILLING_B=$(curl -s -b "$JAR_OWNER_B" "$BASE/api/restaurants/$SLUG_B/billing")
echo "$BILLING_B" | jq -e '.planKey == null and .subscriptionStatus == "trialing"' >/dev/null \
  && pass "restaurant B's own billing is untouched by anything done to restaurant A" || fail "restaurant B billing wrong: $BILLING_B"

echo "----------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PHASE 10 ASSERTIONS PASSED"
else
  echo "SOME PHASE 10 ASSERTIONS FAILED"
fi
exit $FAIL
