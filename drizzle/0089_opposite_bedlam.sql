CREATE TABLE "menu_item_tax_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"effective_from" date NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_tax_rate_history_non_negative" CHECK ("menu_item_tax_rate_history"."tax_rate_basis_points" >= 0),
	CONSTRAINT "menu_item_tax_rate_history_le_10000" CHECK ("menu_item_tax_rate_history"."tax_rate_basis_points" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "menu_item_tax_rate_history" ADD CONSTRAINT "menu_item_tax_rate_history_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_tax_rate_history" ADD CONSTRAINT "menu_item_tax_rate_history_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_tax_rate_history" ADD CONSTRAINT "menu_item_tax_rate_history_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_item_tax_rate_history_menu_item_id_idx" ON "menu_item_tax_rate_history" USING btree ("menu_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_tax_rate_history_item_date_unique" ON "menu_item_tax_rate_history" USING btree ("menu_item_id","effective_from");