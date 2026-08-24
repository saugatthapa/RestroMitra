ALTER TYPE "public"."waste_reason" ADD VALUE 'damaged' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."waste_reason" ADD VALUE 'burned' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "unit_cost_in_paisa_snapshot" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "total_cost_in_paisa_snapshot" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_cost_snapshot_non_negative" CHECK ("stock_movements"."unit_cost_in_paisa_snapshot" IS NULL OR "stock_movements"."unit_cost_in_paisa_snapshot" >= 0);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_total_cost_snapshot_non_negative" CHECK ("stock_movements"."total_cost_in_paisa_snapshot" IS NULL OR "stock_movements"."total_cost_in_paisa_snapshot" >= 0);