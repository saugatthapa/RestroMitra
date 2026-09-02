CREATE TABLE "addon_recipe_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity_per_serving_milliunits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_variants" ADD COLUMN "recipe_quantity_multiplier_basis_points" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "addon_recipe_items" ADD CONSTRAINT "addon_recipe_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_recipe_items" ADD CONSTRAINT "addon_recipe_items_addon_id_menu_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."menu_addons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_recipe_items" ADD CONSTRAINT "addon_recipe_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addon_recipe_items_restaurant_id_idx" ON "addon_recipe_items" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "addon_recipe_items_addon_id_idx" ON "addon_recipe_items" USING btree ("addon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "addon_recipe_items_addon_ingredient_unique" ON "addon_recipe_items" USING btree ("addon_id","inventory_item_id");--> statement-breakpoint
ALTER TABLE "menu_variants" ADD CONSTRAINT "menu_variants_recipe_multiplier_positive" CHECK ("menu_variants"."recipe_quantity_multiplier_basis_points" > 0);