CREATE TABLE "menu_combo_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combo_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_combo_items_quantity_positive" CHECK ("menu_combo_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "menu_combos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"price_in_paisa" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_combos_price_positive" CHECK ("menu_combos"."price_in_paisa" > 0)
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "combo_group_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "combo_name_snapshot" varchar(150);--> statement-breakpoint
ALTER TABLE "menu_combo_items" ADD CONSTRAINT "menu_combo_items_combo_id_menu_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."menu_combos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_combo_items" ADD CONSTRAINT "menu_combo_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_combo_items" ADD CONSTRAINT "menu_combo_items_variant_id_menu_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."menu_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_combos" ADD CONSTRAINT "menu_combos_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_combo_items_combo_id_idx" ON "menu_combo_items" USING btree ("combo_id");--> statement-breakpoint
CREATE INDEX "menu_combos_restaurant_id_idx" ON "menu_combos" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "order_items_combo_group_id_idx" ON "order_items" USING btree ("combo_group_id");