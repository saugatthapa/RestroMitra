#!/usr/bin/env bash
# Phase 7 live HTTP/DB smoke test: suppliers, inventory items, purchases
# (weighted-average costing), recipes, and recipe-driven stock deduction on
# the confirmed -> preparing order transition — run against the actual dev
# server + real Postgres (not mocks). Prints PASS/FAIL per assertion and
# exits non-zero on any failure.
#
# Note: staff management (inviting an inventory_manager/waiter account)
# isn't built until Phase 8, so this script can only drive the API as the
# restaurant owner (who holds every permission, including MANAGE_INVENTORY
# and VIEW_PROFIT). The inventory_manager-vs-waiter permission split for
# narrower roles is proven directly against the DB in
# src/db/__tests__/inventory-permissions.test.ts instead, since there's no
# HTTP surface yet to create those accounts.
set -uo pipefail

BASE="http://localhost:3100"
JAR_A=$(mktemp)
JAR_B=$(mktemp)
SUFFIX=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FAKE_IP="203.0.113.$((RANDOM % 254 + 1))"
hdr=(-H "Content-Type: application/json" -H "x-dhankipos-client: web" -H "x-forwarded-for: $FAKE_IP")
rand8() { printf '%08d' $((RANDOM * 100 + RANDOM % 100)); }

# --- Setup: owner A, restaurant, menu, table -------------------------------
PHONE_A="98$(rand8)"
curl -s -c "$JAR_A" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Inv Owner A\",\"phone\":\"$PHONE_A\",\"email\":\"inv.a.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null

ONB_A=$(curl -s -b "$JAR_A" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Inventory Restaurant A $SUFFIX\",\"type\":\"cafe\",\"address\":\"Dharan Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9811110003\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}")
SLUG_A=$(echo "$ONB_A" | jq -r '.slug')
[ -n "$SLUG_A" ] && [ "$SLUG_A" != "null" ] && pass "onboard restaurant A ($SLUG_A)" || fail "onboard restaurant A: $ONB_A"

CAT_ID=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/categories" "${hdr[@]}" -d '{"name":"TEST MAINS"}' | jq -r '.category.id')

# --- Suppliers --------------------------------------------------------------
SUPPLIER_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/suppliers" "${hdr[@]}" -d '{"name":"TEST Itahari Wholesale","phone":"9801234567"}')
SUPPLIER_ID=$(echo "$SUPPLIER_RES" | jq -r '.supplier.id')
[ -n "$SUPPLIER_ID" ] && [ "$SUPPLIER_ID" != "null" ] && pass "supplier created" || fail "supplier create: $SUPPLIER_RES"

SUPPLIERS_LIST=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/suppliers")
echo "$SUPPLIERS_LIST" | jq -e --arg id "$SUPPLIER_ID" '.suppliers[] | select(.id == $id)' >/dev/null \
  && pass "supplier appears in list" || fail "supplier missing from list: $SUPPLIERS_LIST"

# --- Inventory items ---------------------------------------------------------
FLOUR_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/inventory-items" "${hdr[@]}" -d "{\"name\":\"TEST Flour\",\"unit\":\"kg\",\"reorderLevel\":8,\"preferredSupplierId\":\"$SUPPLIER_ID\"}")
FLOUR_ID=$(echo "$FLOUR_RES" | jq -r '.inventoryItem.id')
[ -n "$FLOUR_ID" ] && [ "$FLOUR_ID" != "null" ] && pass "flour inventory item created" || fail "flour create: $FLOUR_RES"
[ "$(echo "$FLOUR_RES" | jq -r '.inventoryItem.currentStockMilliunits')" = "0" ] && pass "new item starts at zero stock" || fail "new item did not start at zero: $FLOUR_RES"

# --- Manual adjustment: record existing stock on hand ------------------------
ADJ_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/inventory-items/$FLOUR_ID/adjustments" "${hdr[@]}" -d '{"quantity":10,"direction":"add","reason":"TEST initial stock count"}')
[ "$(echo "$ADJ_RES" | jq -r '.inventoryItem.currentStockMilliunits')" = "10000" ] && pass "manual adjustment: +10kg -> 10000 milliunits" || fail "adjustment: $ADJ_RES"

# --- Purchase: weighted-average costing --------------------------------------
PURCHASE_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/purchases" "${hdr[@]}" -d "{\"supplierId\":\"$SUPPLIER_ID\",\"invoiceNumber\":\"TEST-INV-001\",\"items\":[{\"inventoryItemId\":\"$FLOUR_ID\",\"quantity\":5,\"unitCost\":250}]}")
PURCHASE_ID=$(echo "$PURCHASE_RES" | jq -r '.purchase.id')
[ -n "$PURCHASE_ID" ] && [ "$PURCHASE_ID" != "null" ] && pass "purchase recorded (5kg @ Rs 250/kg)" || fail "purchase: $PURCHASE_RES"
[ "$(echo "$PURCHASE_RES" | jq -r '.purchase.totalInPaisa')" = "125000" ] && pass "purchase total = Rs 1250.00 (125000 paisa)" || fail "purchase total wrong: $PURCHASE_RES"

ITEMS_AFTER_PURCHASE=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/inventory-items")
FLOUR_STOCK=$(echo "$ITEMS_AFTER_PURCHASE" | jq -r --arg id "$FLOUR_ID" '.inventoryItems[] | select(.id == $id) | .currentStockMilliunits')
[ "$FLOUR_STOCK" = "15000" ] && pass "stock after purchase: 10kg + 5kg = 15kg (15000 milliunits)" || fail "stock after purchase wrong: got $FLOUR_STOCK"
FLOUR_COST=$(echo "$ITEMS_AFTER_PURCHASE" | jq -r --arg id "$FLOUR_ID" '.inventoryItems[] | select(.id == $id) | .costPerUnitInPaisa')
# Weighted avg: (10kg*0 + 5kg*25000paisa) / 15kg = 8333 paisa/kg (rounded).
[ "$FLOUR_COST" = "8333" ] && pass "weighted-average cost recomputed correctly: Rs 83.33/kg" || fail "weighted-average cost wrong: got $FLOUR_COST, expected 8333"

# --- Menu item + recipe -------------------------------------------------------
MENU_ITEM_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/menu-items" "${hdr[@]}" -d "{\"categoryId\":\"$CAT_ID\",\"name\":\"TEST Roti\",\"price\":40}")
MENU_ITEM_ID=$(echo "$MENU_ITEM_RES" | jq -r '.menuItem.id')
[ -n "$MENU_ITEM_ID" ] && [ "$MENU_ITEM_ID" != "null" ] && pass "menu item created" || fail "menu item: $MENU_ITEM_RES"

RECIPE_RES=$(curl -s -b "$JAR_A" -X PUT "$BASE/api/restaurants/$SLUG_A/menu-items/$MENU_ITEM_ID/recipe" "${hdr[@]}" -d "{\"items\":[{\"inventoryItemId\":\"$FLOUR_ID\",\"quantityPerServing\":0.1}]}")
echo "$RECIPE_RES" | jq -e '.items | length == 1' >/dev/null && pass "recipe saved with 1 ingredient" || fail "recipe save: $RECIPE_RES"

RECIPE_GET=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/menu-items/$MENU_ITEM_ID/recipe")
# 0.1kg * Rs 83.33/kg = Rs 8.33 = 833 paisa (rounded).
[ "$(echo "$RECIPE_GET" | jq -r '.costPerServingInPaisa')" = "833" ] && pass "recipe cost-per-serving computed from live ingredient cost: Rs 8.33" || fail "recipe cost wrong: $RECIPE_GET"

# --- Place an order, confirm it, then advance confirmed -> preparing --------
TABLE_RES=$(curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/tables" "${hdr[@]}" -d '{"name":"TEST Table 1"}')
QR_TOKEN=$(echo "$TABLE_RES" | jq -r '.table.qrToken')

ORDER_RES=$(curl -s -X POST "$BASE/api/order/$QR_TOKEN" "${hdr[@]}" -d "{\"items\":[{\"menuItemId\":\"$MENU_ITEM_ID\",\"quantity\":4}]}")
ORDER_ID=$(echo "$ORDER_RES" | jq -r '.order.id')
[ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] && pass "placed an order for 4x TEST Roti" || fail "order placement: $ORDER_RES"

curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"confirmed"}' >/dev/null
PREPARING_RES=$(curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"preparing"}')
[ "$(echo "$PREPARING_RES" | jq -r '.order.status')" = "preparing" ] && pass "order confirmed -> preparing (triggers recipe stock deduction)" || fail "preparing transition: $PREPARING_RES"

# 4 servings * 0.1kg/serving = 0.4kg deducted. 15kg - 0.4kg = 14.6kg = 14600 milliunits.
ITEMS_AFTER_ORDER=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/inventory-items")
FLOUR_STOCK_AFTER=$(echo "$ITEMS_AFTER_ORDER" | jq -r --arg id "$FLOUR_ID" '.inventoryItems[] | select(.id == $id) | .currentStockMilliunits')
[ "$FLOUR_STOCK_AFTER" = "14600" ] && pass "recipe stock deduction: 15kg - (4 x 0.1kg) = 14.6kg" || fail "post-order stock wrong: got $FLOUR_STOCK_AFTER, expected 14600"

# --- Idempotency: preparing -> ready must NOT deduct flour again ------------
curl -s -b "$JAR_A" -X PATCH "$BASE/api/restaurants/$SLUG_A/orders/$ORDER_ID/status" "${hdr[@]}" -d '{"status":"ready"}' >/dev/null
ITEMS_AFTER_READY=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/inventory-items")
FLOUR_STOCK_AFTER_READY=$(echo "$ITEMS_AFTER_READY" | jq -r --arg id "$FLOUR_ID" '.inventoryItems[] | select(.id == $id) | .currentStockMilliunits')
[ "$FLOUR_STOCK_AFTER_READY" = "14600" ] && pass "preparing -> ready does not deduct stock again (idempotent)" || fail "stock changed on a non-deducting transition: got $FLOUR_STOCK_AFTER_READY"

# --- Low stock flag -----------------------------------------------------------
# Reorder level is 8kg; drop stock to 5kg via a manual removal to trip it.
curl -s -b "$JAR_A" -X POST "$BASE/api/restaurants/$SLUG_A/inventory-items/$FLOUR_ID/adjustments" "${hdr[@]}" -d '{"quantity":9.6,"direction":"remove","reason":"TEST drop below reorder level"}' >/dev/null
ITEMS_LOW=$(curl -s -b "$JAR_A" "$BASE/api/restaurants/$SLUG_A/inventory-items")
IS_LOW=$(echo "$ITEMS_LOW" | jq -r --arg id "$FLOUR_ID" '.inventoryItems[] | select(.id == $id) | .isLowStock')
[ "$IS_LOW" = "true" ] && pass "isLowStock flips true once stock drops to/below the 8kg reorder level" || fail "isLowStock did not flip: $ITEMS_LOW"

# --- Cross-tenant isolation ---------------------------------------------------
PHONE_B="97$(rand8)"
curl -s -c "$JAR_B" -X POST "$BASE/api/auth/register" "${hdr[@]}" -d "{\"fullName\":\"TEST Inv Owner B\",\"phone\":\"$PHONE_B\",\"email\":\"inv.b.$SUFFIX@example.com\",\"password\":\"testpass123\"}" >/dev/null
curl -s -b "$JAR_B" -X POST "$BASE/api/onboarding/restaurant" "${hdr[@]}" -d "{\"name\":\"TEST Inventory Restaurant B $SUFFIX\",\"type\":\"cafe\",\"address\":\"Main Road\",\"city\":\"Itahari\",\"district\":\"Sunsari\",\"phone\":\"9822220003\",\"openTime\":\"09:00\",\"closeTime\":\"21:00\"}" >/dev/null

CROSS_ITEMS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" "$BASE/api/restaurants/$SLUG_A/inventory-items")
[ "$CROSS_ITEMS_CODE" = "403" ] && pass "owner B gets 403 reading restaurant A's inventory items" || fail "cross-tenant inventory read returned $CROSS_ITEMS_CODE, expected 403"

CROSS_ADJ_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X POST "$BASE/api/restaurants/$SLUG_A/inventory-items/$FLOUR_ID/adjustments" "${hdr[@]}" -d '{"quantity":1,"direction":"add","reason":"attack"}')
[ "$CROSS_ADJ_CODE" = "403" ] && pass "owner B gets 403 adjusting restaurant A's stock" || fail "cross-tenant adjustment returned $CROSS_ADJ_CODE, expected 403"

CROSS_PURCHASE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_B" -X POST "$BASE/api/restaurants/$SLUG_A/purchases" "${hdr[@]}" -d "{\"items\":[{\"inventoryItemId\":\"$FLOUR_ID\",\"quantity\":1,\"unitCost\":1}]}")
[ "$CROSS_PURCHASE_CODE" = "403" ] && pass "owner B gets 403 recording a purchase against restaurant A" || fail "cross-tenant purchase returned $CROSS_PURCHASE_CODE, expected 403"

echo "---"
echo "SLUG_A=$SLUG_A FLOUR_ID=$FLOUR_ID MENU_ITEM_ID=$MENU_ITEM_ID ORDER_ID=$ORDER_ID"
if [ "$FAIL" = "0" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; fi
exit $FAIL
