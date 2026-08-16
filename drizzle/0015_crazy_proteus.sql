CREATE TYPE "public"."table_shape" AS ENUM('rectangle', 'circle', 'square');--> statement-breakpoint
CREATE TYPE "public"."table_status" AS ENUM('available', 'ordering', 'occupied', 'reserved', 'payment_pending', 'cleaning', 'out_of_service');--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "status" "table_status" DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "pos_x" integer;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "pos_y" integer;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "width" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "height" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "shape" "table_shape" DEFAULT 'rectangle' NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "rotation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD COLUMN "floor_label" varchar(50);--> statement-breakpoint
CREATE INDEX "restaurant_tables_status_idx" ON "restaurant_tables" USING btree ("status");