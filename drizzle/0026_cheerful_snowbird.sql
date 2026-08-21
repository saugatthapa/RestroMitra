ALTER TABLE "restaurants" ADD COLUMN "locked_monthly_price_in_paisa" integer;
--> statement-breakpoint
-- Phase 25c Growth reprice (Rs 1,799 -> Rs 1,399/mo): lock every restaurant
-- already assigned the "growth" plan to the OLD rate (179900 paisa) they
-- were already quoted/billed, so this migration landing at the same time
-- as the src/lib/plans.ts catalog change never silently changes what an
-- existing restaurant pays. New "growth" assignments after this migration
-- get lockedMonthlyPriceInPaisa = null and pay whatever plans.ts says
-- (see getEffectivePlan() in src/lib/plans.ts, and the admin subscription
-- route, which always clears this column back to null on a fresh
-- assign_plan call). The 179900 literal below is deliberate -- it is the
-- price this migration is grandfathering IN, not a reference to whatever
-- plans.ts happens to say at migration time.
UPDATE "restaurants" SET "locked_monthly_price_in_paisa" = 179900 WHERE "plan_key" = 'growth';