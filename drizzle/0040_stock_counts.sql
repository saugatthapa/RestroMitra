CREATE TYPE "public"."stock_count_status" AS ENUM('open', 'pending_approval', 'applied', 'rejected');--> statement-breakpoint
CREATE TABLE "stock_count_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"system_quantity_milliunits" integer NOT NULL,
	"physical_quantity_milliunits" integer,
	"unit_cost_in_paisa_snapshot" integer NOT NULL,
	"note" text,
	"counted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_items_unit_cost_non_negative" CHECK ("stock_count_items"."unit_cost_in_paisa_snapshot" >= 0),
	CONSTRAINT "stock_count_items_physical_quantity_non_negative" CHECK ("stock_count_items"."physical_quantity_milliunits" IS NULL OR "stock_count_items"."physical_quantity_milliunits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" "stock_count_status" DEFAULT 'open' NOT NULL,
	"notes" text,
	"counted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"has_large_variance" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_approved_fields_consistent" CHECK (("stock_counts"."approved_by_user_id" IS NULL AND "stock_counts"."approved_at" IS NULL)
          OR ("stock_counts"."approved_by_user_id" IS NOT NULL AND "stock_counts"."approved_at" IS NOT NULL)),
	CONSTRAINT "stock_counts_rejected_fields_consistent" CHECK (("stock_counts"."status" <> 'rejected' AND "stock_counts"."rejected_by_user_id" IS NULL AND "stock_counts"."rejected_at" IS NULL AND "stock_counts"."rejection_reason" IS NULL)
          OR ("stock_counts"."status" = 'rejected' AND "stock_counts"."rejected_by_user_id" IS NOT NULL AND "stock_counts"."rejected_at" IS NOT NULL AND "stock_counts"."rejection_reason" IS NOT NULL)),
	CONSTRAINT "stock_counts_submitted_fields_consistent" CHECK (("stock_counts"."status" = 'open' AND "stock_counts"."submitted_at" IS NULL)
          OR ("stock_counts"."status" <> 'open' AND "stock_counts"."submitted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_stock_count_id_stock_counts_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_user_id_users_id_fk" FOREIGN KEY ("counted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_count_items_stock_count_id_idx" ON "stock_count_items" USING btree ("stock_count_id");--> statement-breakpoint
CREATE INDEX "stock_count_items_inventory_item_id_idx" ON "stock_count_items" USING btree ("inventory_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_items_count_item_unique" ON "stock_count_items" USING btree ("stock_count_id","inventory_item_id");--> statement-breakpoint
CREATE INDEX "stock_counts_restaurant_id_idx" ON "stock_counts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "stock_counts_branch_id_idx" ON "stock_counts" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "stock_counts_status_idx" ON "stock_counts" USING btree ("status");