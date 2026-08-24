CREATE TYPE "public"."stock_transfer_status" AS ENUM('requested', 'approved', 'dispatched', 'received', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'transfer_out';--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'transfer_in';--> statement-breakpoint
CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_transfer_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity_milliunits" integer NOT NULL,
	"received_quantity_milliunits" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_items_quantity_positive" CHECK ("stock_transfer_items"."quantity_milliunits" > 0),
	CONSTRAINT "stock_transfer_items_received_quantity_non_negative" CHECK ("stock_transfer_items"."received_quantity_milliunits" IS NULL OR "stock_transfer_items"."received_quantity_milliunits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"from_branch_id" uuid NOT NULL,
	"to_branch_id" uuid NOT NULL,
	"status" "stock_transfer_status" DEFAULT 'requested' NOT NULL,
	"notes" text,
	"requested_by_user_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"dispatched_by_user_id" uuid,
	"dispatched_at" timestamp with time zone,
	"received_by_user_id" uuid,
	"received_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_branches_distinct" CHECK ("stock_transfers"."from_branch_id" <> "stock_transfers"."to_branch_id"),
	CONSTRAINT "stock_transfers_approved_fields_consistent" CHECK (("stock_transfers"."approved_by_user_id" IS NULL AND "stock_transfers"."approved_at" IS NULL)
          OR ("stock_transfers"."approved_by_user_id" IS NOT NULL AND "stock_transfers"."approved_at" IS NOT NULL)),
	CONSTRAINT "stock_transfers_dispatched_fields_consistent" CHECK (("stock_transfers"."dispatched_by_user_id" IS NULL AND "stock_transfers"."dispatched_at" IS NULL)
          OR ("stock_transfers"."dispatched_by_user_id" IS NOT NULL AND "stock_transfers"."dispatched_at" IS NOT NULL)),
	CONSTRAINT "stock_transfers_received_fields_consistent" CHECK (("stock_transfers"."received_by_user_id" IS NULL AND "stock_transfers"."received_at" IS NULL)
          OR ("stock_transfers"."received_by_user_id" IS NOT NULL AND "stock_transfers"."received_at" IS NOT NULL)),
	CONSTRAINT "stock_transfers_cancelled_fields_consistent" CHECK (("stock_transfers"."status" <> 'cancelled' AND "stock_transfers"."cancelled_by_user_id" IS NULL AND "stock_transfers"."cancelled_at" IS NULL AND "stock_transfers"."cancellation_reason" IS NULL)
          OR ("stock_transfers"."status" = 'cancelled' AND "stock_transfers"."cancelled_by_user_id" IS NOT NULL AND "stock_transfers"."cancelled_at" IS NOT NULL AND "stock_transfers"."cancellation_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_stock_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("stock_transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatched_by_user_id_users_id_fk" FOREIGN KEY ("dispatched_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_transfer_items_stock_transfer_id_idx" ON "stock_transfer_items" USING btree ("stock_transfer_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_items_inventory_item_id_idx" ON "stock_transfer_items" USING btree ("inventory_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_items_transfer_item_unique" ON "stock_transfer_items" USING btree ("stock_transfer_id","inventory_item_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_restaurant_id_idx" ON "stock_transfers" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_from_branch_id_idx" ON "stock_transfers" USING btree ("from_branch_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_to_branch_id_idx" ON "stock_transfers" USING btree ("to_branch_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers" USING btree ("status");