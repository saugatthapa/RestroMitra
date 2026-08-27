CREATE TABLE "plans" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"tagline" text NOT NULL,
	"price_in_paisa_monthly" integer NOT NULL,
	"max_staff" integer,
	"max_branches" integer,
	"highlight" boolean DEFAULT false NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feature_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the 3 plans that previously lived as hardcoded rows in
-- src/lib/plans.ts (see that file's own "PRICING HISTORY" comment for
-- where these exact numbers came from). Must run BEFORE the FK constraint
-- below is added — any restaurant already carrying a non-null plan_key
-- enum value needs a matching plans.key row to reference, or that ALTER
-- TABLE ADD CONSTRAINT fails against existing data.
--
-- featureKeys mapping rationale (Phase 5's entitlement engine, not yet
-- built, is what will actually enforce these): starter gets the
-- always-been-available day-one operational features; growth adds every
-- capability explicitly called out in its own marketing bullets above,
-- plus the natural companions of those (suppliers/payroll alongside
-- inventory/expense tracking); pro — the unlimited flagship tier — gets
-- every feature key that exists except staff_attendance, which is
-- reserved for the not-yet-built attendance track and isn't sold on any
-- plan yet.
INSERT INTO "plans" ("key", "name", "tagline", "price_in_paisa_monthly", "max_staff", "max_branches", "highlight", "features", "feature_keys", "sort_order", "is_active") VALUES
('starter', 'Starter', 'Everything a single counter needs to go digital.', 79900, 5, 1, false,
  '["QR table ordering","POS & billing","Kitchen display (KDS)","eSewa & Khalti payments","Up to 5 staff accounts","1 branch"]'::jsonb,
  '["qr_ordering","pos_billing","kds","payment_gateways","table_management","cash_register","combos_coupons","account_books","data_export"]'::jsonb,
  0, true),
('growth', 'Growth', 'For restaurants ready to manage cost, customers, and more than one till.', 139900, 15, 3, true,
  '["Everything in Starter","Inventory & recipe costing","Customers & loyalty program","AI restaurant assistant","Website builder","Expense tracking & reports","Up to 15 staff accounts","Up to 3 branches"]'::jsonb,
  '["qr_ordering","pos_billing","kds","payment_gateways","table_management","cash_register","combos_coupons","account_books","data_export","inventory","recipe_costing","suppliers_ap","customers_loyalty","ai_assistant","website_builder","expense_tracking","reports","multi_branch","payroll"]'::jsonb,
  1, true),
('pro', 'Pro', 'Unlimited staff and branches, with reservations and priority support.', 349900, NULL, NULL, false,
  '["Everything in Growth","Reservations","Unlimited staff accounts","Unlimited branches","Priority support"]'::jsonb,
  '["qr_ordering","pos_billing","kds","payment_gateways","table_management","cash_register","combos_coupons","account_books","data_export","inventory","recipe_costing","suppliers_ap","customers_loyalty","ai_assistant","website_builder","expense_tracking","reports","multi_branch","payroll","reservations"]'::jsonb,
  2, true);
--> statement-breakpoint
ALTER TABLE "restaurants" ALTER COLUMN "plan_key" SET DATA TYPE varchar(40);--> statement-breakpoint
ALTER TABLE "subscription_events" ALTER COLUMN "plan_key" SET DATA TYPE varchar(40);--> statement-breakpoint
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_plan_key_plans_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plans"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."plan_key";