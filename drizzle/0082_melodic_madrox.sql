CREATE TYPE "public"."account_normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."accounting_period_status" AS ENUM('open', 'closed', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."accounting_voucher_status" AS ENUM('draft', 'approved', 'posted', 'reversed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."accounting_voucher_type" AS ENUM('journal', 'sales', 'purchase', 'payment', 'expense', 'refund', 'contra', 'payroll', 'opening_balance');--> statement-breakpoint
CREATE TABLE "account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"mapping_key" varchar(100) NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "accounting_period_status" DEFAULT 'open' NOT NULL,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"reopened_by_user_id" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_periods_range_valid" CHECK ("accounting_periods"."period_end" >= "accounting_periods"."period_start")
);
--> statement-breakpoint
CREATE TABLE "accounting_voucher_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"voucher_type" "accounting_voucher_type" NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_voucher_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_in_paisa" integer DEFAULT 0 NOT NULL,
	"credit_in_paisa" integer DEFAULT 0 NOT NULL,
	"description" varchar(300),
	"customer_id" uuid,
	"supplier_id" uuid,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_voucher_lines_one_sided" CHECK (("accounting_voucher_lines"."debit_in_paisa" > 0 AND "accounting_voucher_lines"."credit_in_paisa" = 0) OR ("accounting_voucher_lines"."credit_in_paisa" > 0 AND "accounting_voucher_lines"."debit_in_paisa" = 0))
);
--> statement-breakpoint
CREATE TABLE "accounting_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"voucher_type" "accounting_voucher_type" NOT NULL,
	"voucher_number" varchar(30) NOT NULL,
	"voucher_date" date DEFAULT now() NOT NULL,
	"reference" varchar(100),
	"narration" text,
	"status" "accounting_voucher_status" DEFAULT 'posted' NOT NULL,
	"created_by_user_id" uuid,
	"posted_by_user_id" uuid,
	"posted_at" timestamp with time zone,
	"reversal_of_voucher_id" uuid,
	"source_type" varchar(60),
	"source_id" uuid,
	"posting_event" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_vouchers_source_triple_consistent" CHECK (("accounting_vouchers"."source_type" IS NULL AND "accounting_vouchers"."source_id" IS NULL AND "accounting_vouchers"."posting_event" IS NULL)
          OR ("accounting_vouchers"."source_type" IS NOT NULL AND "accounting_vouchers"."source_id" IS NOT NULL AND "accounting_vouchers"."posting_event" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "chart_of_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" varchar(20) NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" "account_type" NOT NULL,
	"normal_balance" "account_normal_balance" NOT NULL,
	"parent_account_id" uuid,
	"is_system_account" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_reopened_by_user_id_users_id_fk" FOREIGN KEY ("reopened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_voucher_counters" ADD CONSTRAINT "accounting_voucher_counters_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_voucher_lines" ADD CONSTRAINT "accounting_voucher_lines_voucher_id_accounting_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."accounting_vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_voucher_lines" ADD CONSTRAINT "accounting_voucher_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_voucher_lines" ADD CONSTRAINT "accounting_voucher_lines_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_voucher_lines" ADD CONSTRAINT "accounting_voucher_lines_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_voucher_lines" ADD CONSTRAINT "accounting_voucher_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_vouchers" ADD CONSTRAINT "accounting_vouchers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_vouchers" ADD CONSTRAINT "accounting_vouchers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_vouchers" ADD CONSTRAINT "accounting_vouchers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_vouchers" ADD CONSTRAINT "accounting_vouchers_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_vouchers" ADD CONSTRAINT "accounting_vouchers_reversal_of_voucher_id_accounting_vouchers_id_fk" FOREIGN KEY ("reversal_of_voucher_id") REFERENCES "public"."accounting_vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_mappings_restaurant_id_idx" ON "account_mappings" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_mappings_restaurant_key_unique" ON "account_mappings" USING btree ("restaurant_id","mapping_key");--> statement-breakpoint
CREATE INDEX "accounting_periods_restaurant_id_idx" ON "accounting_periods" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "accounting_periods_range_idx" ON "accounting_periods" USING btree ("restaurant_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_voucher_counters_restaurant_type_unique" ON "accounting_voucher_counters" USING btree ("restaurant_id","voucher_type");--> statement-breakpoint
CREATE INDEX "accounting_voucher_lines_voucher_id_idx" ON "accounting_voucher_lines" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "accounting_voucher_lines_account_id_idx" ON "accounting_voucher_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "accounting_voucher_lines_customer_id_idx" ON "accounting_voucher_lines" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "accounting_voucher_lines_supplier_id_idx" ON "accounting_voucher_lines" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "accounting_voucher_lines_order_id_idx" ON "accounting_voucher_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "accounting_vouchers_restaurant_id_idx" ON "accounting_vouchers" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "accounting_vouchers_branch_id_idx" ON "accounting_vouchers" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "accounting_vouchers_voucher_date_idx" ON "accounting_vouchers" USING btree ("voucher_date");--> statement-breakpoint
CREATE INDEX "accounting_vouchers_reversal_of_voucher_id_idx" ON "accounting_vouchers" USING btree ("reversal_of_voucher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_vouchers_restaurant_voucher_number_unique" ON "accounting_vouchers" USING btree ("restaurant_id","voucher_number");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_vouchers_source_unique" ON "accounting_vouchers" USING btree ("restaurant_id","source_type","source_id","posting_event") WHERE "accounting_vouchers"."source_type" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chart_of_accounts_restaurant_id_idx" ON "chart_of_accounts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "chart_of_accounts_parent_account_id_idx" ON "chart_of_accounts" USING btree ("parent_account_id");--> statement-breakpoint
CREATE INDEX "chart_of_accounts_branch_id_idx" ON "chart_of_accounts" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_of_accounts_restaurant_code_unique" ON "chart_of_accounts" USING btree ("restaurant_id","code");