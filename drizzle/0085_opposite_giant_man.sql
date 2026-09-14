CREATE TYPE "public"."fixed_asset_depreciation_method" AS ENUM('straight_line');--> statement-breakpoint
ALTER TYPE "public"."accounting_voucher_type" ADD VALUE 'fixed_asset';--> statement-breakpoint
ALTER TYPE "public"."accounting_voucher_type" ADD VALUE 'depreciation';--> statement-breakpoint
CREATE TABLE "fixed_asset_depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_in_paisa" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_depreciation_entries_amount_positive" CHECK ("fixed_asset_depreciation_entries"."amount_in_paisa" > 0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"chart_of_accounts_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"category" varchar(100),
	"acquisition_date" date NOT NULL,
	"cost_in_paisa" integer NOT NULL,
	"useful_life_months" integer NOT NULL,
	"salvage_value_in_paisa" integer DEFAULT 0 NOT NULL,
	"depreciation_method" "fixed_asset_depreciation_method" DEFAULT 'straight_line' NOT NULL,
	"accumulated_depreciation_in_paisa" integer DEFAULT 0 NOT NULL,
	"disposed_at" timestamp with time zone,
	"disposal_voucher_id" uuid,
	"disposal_proceeds_in_paisa" integer,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_life_and_values_valid" CHECK ("fixed_assets"."useful_life_months" > 0 AND "fixed_assets"."cost_in_paisa" >= 0 AND "fixed_assets"."salvage_value_in_paisa" >= 0 AND "fixed_assets"."salvage_value_in_paisa" <= "fixed_assets"."cost_in_paisa")
);
--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_fixed_asset_id_fixed_assets_id_fk" FOREIGN KEY ("fixed_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_voucher_id_accounting_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."accounting_vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_chart_of_accounts_id_chart_of_accounts_id_fk" FOREIGN KEY ("chart_of_accounts_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_voucher_id_accounting_vouchers_id_fk" FOREIGN KEY ("disposal_voucher_id") REFERENCES "public"."accounting_vouchers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixed_asset_depreciation_entries_restaurant_id_idx" ON "fixed_asset_depreciation_entries" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "fixed_asset_depreciation_entries_fixed_asset_id_idx" ON "fixed_asset_depreciation_entries" USING btree ("fixed_asset_id");--> statement-breakpoint
CREATE INDEX "fixed_asset_depreciation_entries_voucher_id_idx" ON "fixed_asset_depreciation_entries" USING btree ("voucher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_asset_depreciation_entries_asset_period_end_unique" ON "fixed_asset_depreciation_entries" USING btree ("fixed_asset_id","period_end");--> statement-breakpoint
CREATE INDEX "fixed_assets_restaurant_id_idx" ON "fixed_assets" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_chart_of_accounts_id_unique" ON "fixed_assets" USING btree ("chart_of_accounts_id");