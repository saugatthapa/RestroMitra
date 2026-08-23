CREATE TABLE "branch_inventory_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"current_stock_milliunits" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "branch_inventory_levels" ADD CONSTRAINT "branch_inventory_levels_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_inventory_levels" ADD CONSTRAINT "branch_inventory_levels_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_inventory_levels_branch_item_unique" ON "branch_inventory_levels" USING btree ("branch_id","inventory_item_id");--> statement-breakpoint
CREATE INDEX "branch_inventory_levels_inventory_item_id_idx" ON "branch_inventory_levels" USING btree ("inventory_item_id");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchases_branch_id_idx" ON "purchases" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_branch_id_idx" ON "stock_movements" USING btree ("branch_id");
--> statement-breakpoint
-- Hand-written data migration below (not drizzle-kit generated) --------------
--
-- P2 — branch-scoping inventory. Every restaurant has had exactly one
-- branch flagged is_main = true since onboarding (see
-- src/app/api/onboarding/restaurant/route.ts) and branches are never
-- hard-deleted (no DELETE endpoint exists), so "the restaurant's main
-- branch" is always resolvable for every restaurant with historical
-- purchases/stock movements.
--
-- 1) Backfill purchases.branch_id. Historical purchases predate any
--    concept of branch-scoped inventory and carry no real signal for which
--    branch physically received the delivery — defaulting every existing
--    purchase to the restaurant's main branch is a best-effort assumption,
--    not a reconstruction of fact. For a restaurant that has only ever had
--    one branch (the common case) this is exactly correct, not a guess.
--    For a genuinely multi-branch restaurant with pre-existing purchase
--    history, this may misattribute which branch actually received older
--    stock — a physical stock count (tracked separately, see
--    BRANCH_INVENTORY.md) is the intended way to correct any resulting
--    per-branch drift after this migration lands.
UPDATE "purchases" p
SET "branch_id" = b."id"
FROM "branches" b
WHERE b."restaurant_id" = p."restaurant_id"
  AND b."is_main" = true
  AND p."branch_id" IS NULL;
--> statement-breakpoint
-- 2) Backfill stock_movements.branch_id for "purchase" rows from the
--    purchase they reference (now itself backfilled above) — this IS a
--    real signal, not a guess, wherever the purchase row still exists.
UPDATE "stock_movements" sm
SET "branch_id" = p."branch_id"
FROM "purchases" p
WHERE sm."type" = 'purchase'
  AND sm."reference_type" = 'purchase'
  AND sm."reference_id" = p."id"
  AND sm."branch_id" IS NULL;
--> statement-breakpoint
-- 3) Backfill stock_movements.branch_id for "sale_deduction" rows from the
--    order they reference — real signal (orders have always been
--    branch-scoped), not a guess.
UPDATE "stock_movements" sm
SET "branch_id" = o."branch_id"
FROM "orders" o
WHERE sm."type" = 'sale_deduction'
  AND sm."reference_type" = 'order'
  AND sm."reference_id" = o."id"
  AND sm."branch_id" IS NULL;
--> statement-breakpoint
-- 4) Everything left (manual adjustments, and any purchase/sale_deduction
--    row whose referenced purchase/order no longer exists) falls back to
--    the restaurant's main branch — same best-effort default as (1), same
--    caveat: a physical stock count is the real fix for any resulting
--    per-branch drift on a multi-branch restaurant's pre-migration history.
UPDATE "stock_movements" sm
SET "branch_id" = b."id"
FROM "branches" b
WHERE b."restaurant_id" = sm."restaurant_id"
  AND b."is_main" = true
  AND sm."branch_id" IS NULL;
--> statement-breakpoint
-- 5) Seed branch_inventory_levels from the now-fully-backfilled movement
--    ledger — one row per (branch, item) that has ever moved, summing
--    every signed delta exactly the way recordStockMovement() maintains
--    this table incrementally going forward. This table is brand new
--    (created earlier in this same migration), so there is nothing to
--    conflict with.
INSERT INTO "branch_inventory_levels" ("branch_id", "inventory_item_id", "current_stock_milliunits")
SELECT sm."branch_id", sm."inventory_item_id", SUM(sm."quantity_delta_milliunits")
FROM "stock_movements" sm
WHERE sm."branch_id" IS NOT NULL
GROUP BY sm."branch_id", sm."inventory_item_id";