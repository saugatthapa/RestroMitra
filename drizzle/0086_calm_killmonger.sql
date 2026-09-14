CREATE TYPE "public"."loan_status" AS ENUM('active', 'closed');--> statement-breakpoint
ALTER TYPE "public"."accounting_voucher_type" ADD VALUE 'loan';--> statement-breakpoint
CREATE TABLE "loan_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"principal_in_paisa" integer DEFAULT 0 NOT NULL,
	"interest_in_paisa" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_payments_amounts_valid" CHECK ("loan_payments"."principal_in_paisa" >= 0 AND "loan_payments"."interest_in_paisa" >= 0 AND ("loan_payments"."principal_in_paisa" > 0 OR "loan_payments"."interest_in_paisa" > 0))
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"chart_of_accounts_id" uuid NOT NULL,
	"lender_name" varchar(200) NOT NULL,
	"principal_in_paisa" integer NOT NULL,
	"interest_rate_basis_points" integer,
	"start_date" date NOT NULL,
	"term_months" integer,
	"outstanding_principal_in_paisa" integer NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"closed_at" timestamp with time zone,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_principal_positive" CHECK ("loans"."principal_in_paisa" > 0),
	CONSTRAINT "loans_outstanding_within_range" CHECK ("loans"."outstanding_principal_in_paisa" >= 0 AND "loans"."outstanding_principal_in_paisa" <= "loans"."principal_in_paisa")
);
--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_voucher_id_accounting_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."accounting_vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_chart_of_accounts_id_chart_of_accounts_id_fk" FOREIGN KEY ("chart_of_accounts_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_payments_restaurant_id_idx" ON "loan_payments" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "loan_payments_loan_id_idx" ON "loan_payments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loan_payments_voucher_id_idx" ON "loan_payments" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "loans_restaurant_id_idx" ON "loans" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_chart_of_accounts_id_unique" ON "loans" USING btree ("chart_of_accounts_id");