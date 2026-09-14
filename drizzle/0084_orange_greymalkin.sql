CREATE TYPE "public"."bank_reconciliation_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"chart_of_accounts_id" uuid NOT NULL,
	"bank_name" varchar(150) NOT NULL,
	"account_number" varchar(60),
	"branch_name" varchar(150),
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliation_cleared_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"voucher_line_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_closing_balance_in_paisa" integer NOT NULL,
	"status" "bank_reconciliation_status" DEFAULT 'open' NOT NULL,
	"book_balance_in_paisa" integer,
	"difference_in_paisa" integer,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_chart_of_accounts_id_chart_of_accounts_id_fk" FOREIGN KEY ("chart_of_accounts_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_cleared_lines" ADD CONSTRAINT "bank_reconciliation_cleared_lines_reconciliation_id_bank_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."bank_reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_cleared_lines" ADD CONSTRAINT "bank_reconciliation_cleared_lines_voucher_line_id_accounting_voucher_lines_id_fk" FOREIGN KEY ("voucher_line_id") REFERENCES "public"."accounting_voucher_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_accounts_restaurant_id_idx" ON "bank_accounts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_chart_of_accounts_id_unique" ON "bank_accounts" USING btree ("chart_of_accounts_id");--> statement-breakpoint
CREATE INDEX "bank_reconciliation_cleared_lines_reconciliation_id_idx" ON "bank_reconciliation_cleared_lines" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_cleared_lines_voucher_line_unique" ON "bank_reconciliation_cleared_lines" USING btree ("voucher_line_id");--> statement-breakpoint
CREATE INDEX "bank_reconciliations_restaurant_id_idx" ON "bank_reconciliations" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "bank_reconciliations_bank_account_id_idx" ON "bank_reconciliations" USING btree ("bank_account_id");