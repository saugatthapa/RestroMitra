CREATE TYPE "public"."waste_reason" AS ENUM('spoilage', 'expired', 'breakage', 'overproduction', 'theft_or_loss', 'other');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'waste';--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "waste_reason" "waste_reason";