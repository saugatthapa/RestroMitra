CREATE TYPE "public"."expense_payment_method" AS ENUM('cash', 'bank_transfer', 'esewa', 'khalti', 'mobile_banking', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('pending_approval', 'approved', 'rejected', 'paid');--> statement-breakpoint
ALTER TYPE "public"."system_role" ADD VALUE 'accountant';--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "status" "expense_status" DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "payment_method" "expense_payment_method";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "rejection_reason" varchar(300);--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_categories_restaurant_id_idx" ON "expense_categories" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_restaurant_name_idx" ON "expense_categories" USING btree ("restaurant_id","name");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_branch_id_idx" ON "expenses" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "expenses_category_id_idx" ON "expenses" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "expenses_status_idx" ON "expenses" USING btree ("status");--> statement-breakpoint
-- Hand-written data migration below (not drizzle-kit generated) --------------
--
-- 1) Seed every existing restaurant with the full default expense-category
--    list (Phase 21 spec section 5), so custom categories are available
--    immediately even for a restaurant that hasn't logged an expense yet.
--    New restaurants going forward get these via seedDefaultExpenseCategories()
--    (src/lib/expense-categories.ts) at onboarding time, not this migration.
INSERT INTO "expense_categories" ("restaurant_id", "name", "sort_order")
SELECT r."id", cat.name, cat.sort_order
FROM "restaurants" r
CROSS JOIN (VALUES
  ('Payroll', 0), ('Inventory', 1), ('Food ingredients', 2), ('Beverages', 3),
  ('Rent', 4), ('Utilities', 5), ('Electricity', 6), ('Water', 7),
  ('Internet', 8), ('Gas', 9), ('Maintenance', 10), ('Equipment', 11),
  ('Cleaning', 12), ('Packaging', 13), ('Transportation', 14), ('Delivery', 15),
  ('Marketing', 16), ('Advertising', 17), ('Software', 18), ('Taxes', 19),
  ('Bank charges', 20), ('Payment gateway fees', 21), ('Office expenses', 22),
  ('Miscellaneous', 23)
) AS cat(name, sort_order)
ON CONFLICT ("restaurant_id", "name") DO NOTHING;
--> statement-breakpoint
-- 2) Backfill category_id on every existing expense row from its old
--    `category` enum value, mapped onto the closest new default category.
--    "utilities" maps to the new generic "Utilities" bucket rather than
--    guessing which specific utility (electricity/water/gas) it actually
--    was — we don't have that information in the old data.
UPDATE "expenses" e
SET "category_id" = ec."id"
FROM "expense_categories" ec
WHERE ec."restaurant_id" = e."restaurant_id"
  AND ec."name" = CASE e."category"
    WHEN 'rent' THEN 'Rent'
    WHEN 'utilities' THEN 'Utilities'
    WHEN 'salaries' THEN 'Payroll'
    WHEN 'supplies' THEN 'Inventory'
    WHEN 'maintenance' THEN 'Maintenance'
    WHEN 'marketing' THEN 'Marketing'
    WHEN 'transport' THEN 'Transportation'
    WHEN 'other' THEN 'Miscellaneous'
  END
  AND e."category_id" IS NULL;