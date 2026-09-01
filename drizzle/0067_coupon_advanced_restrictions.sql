CREATE TABLE "coupon_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_customer_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_customer_redemptions_count_non_negative" CHECK ("coupon_customer_redemptions"."redemption_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "coupon_menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "per_customer_limit" integer;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "first_order_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coupon_branches" ADD CONSTRAINT "coupon_branches_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_branches" ADD CONSTRAINT "coupon_branches_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_branches" ADD CONSTRAINT "coupon_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_categories" ADD CONSTRAINT "coupon_categories_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_categories" ADD CONSTRAINT "coupon_categories_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_categories" ADD CONSTRAINT "coupon_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_customer_redemptions" ADD CONSTRAINT "coupon_customer_redemptions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_customer_redemptions" ADD CONSTRAINT "coupon_customer_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_customer_redemptions" ADD CONSTRAINT "coupon_customer_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_menu_items" ADD CONSTRAINT "coupon_menu_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_menu_items" ADD CONSTRAINT "coupon_menu_items_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_menu_items" ADD CONSTRAINT "coupon_menu_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_branches_restaurant_id_idx" ON "coupon_branches" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "coupon_branches_coupon_id_idx" ON "coupon_branches" USING btree ("coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_branches_coupon_branch_unique" ON "coupon_branches" USING btree ("coupon_id","branch_id");--> statement-breakpoint
CREATE INDEX "coupon_categories_restaurant_id_idx" ON "coupon_categories" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "coupon_categories_coupon_id_idx" ON "coupon_categories" USING btree ("coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_categories_coupon_category_unique" ON "coupon_categories" USING btree ("coupon_id","category_id");--> statement-breakpoint
CREATE INDEX "coupon_customer_redemptions_restaurant_id_idx" ON "coupon_customer_redemptions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "coupon_customer_redemptions_customer_id_idx" ON "coupon_customer_redemptions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_customer_redemptions_coupon_customer_unique" ON "coupon_customer_redemptions" USING btree ("coupon_id","customer_id");--> statement-breakpoint
CREATE INDEX "coupon_menu_items_restaurant_id_idx" ON "coupon_menu_items" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "coupon_menu_items_coupon_id_idx" ON "coupon_menu_items" USING btree ("coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_menu_items_coupon_menu_item_unique" ON "coupon_menu_items" USING btree ("coupon_id","menu_item_id");--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_customer_id_idx" ON "coupon_redemptions" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_per_customer_limit_positive" CHECK ("coupons"."per_customer_limit" IS NULL OR "coupons"."per_customer_limit" > 0);