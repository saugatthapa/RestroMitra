CREATE TABLE "order_bill_split_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"split_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_bill_split_items_quantity_positive" CHECK ("order_bill_split_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_bill_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "split_id" uuid;--> statement-breakpoint
ALTER TABLE "order_bill_split_items" ADD CONSTRAINT "order_bill_split_items_split_id_order_bill_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."order_bill_splits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_split_items" ADD CONSTRAINT "order_bill_split_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_splits" ADD CONSTRAINT "order_bill_splits_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_splits" ADD CONSTRAINT "order_bill_splits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_bill_split_items_split_id_idx" ON "order_bill_split_items" USING btree ("split_id");--> statement-breakpoint
CREATE INDEX "order_bill_split_items_order_item_id_idx" ON "order_bill_split_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_bill_splits_order_id_idx" ON "order_bill_splits" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_bill_splits_restaurant_id_idx" ON "order_bill_splits" USING btree ("restaurant_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_split_id_order_bill_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."order_bill_splits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_split_id_idx" ON "payments" USING btree ("split_id");