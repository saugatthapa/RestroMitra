CREATE TYPE "public"."discount_type" AS ENUM('percentage', 'flat');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_type" "discount_type";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_value" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_in_paisa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_reason" varchar(300);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "service_charge_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "service_charge_in_paisa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tip_in_paisa" integer DEFAULT 0 NOT NULL;