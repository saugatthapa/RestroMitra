CREATE TYPE "public"."salary_type" AS ENUM('monthly', 'daily', 'hourly');--> statement-breakpoint
ALTER TYPE "public"."ledger_category" ADD VALUE 'payroll' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "payroll_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"user_role_id" uuid NOT NULL,
	"staff_name_snapshot" varchar(200) NOT NULL,
	"amount_in_paisa" integer NOT NULL,
	"pay_period_label" varchar(100),
	"period_start" date,
	"period_end" date,
	"payment_method" "expense_payment_method" NOT NULL,
	"note" text,
	"is_voided" boolean DEFAULT false NOT NULL,
	"paid_by_user_id" uuid,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_salary_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_role_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"salary_type" "salary_type" DEFAULT 'monthly' NOT NULL,
	"amount_in_paisa" integer NOT NULL,
	"payment_method" "expense_payment_method",
	"bank_name" varchar(150),
	"bank_account_number" varchar(50),
	"bank_account_holder" varchar(200),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_user_role_id_user_roles_id_fk" FOREIGN KEY ("user_role_id") REFERENCES "public"."user_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salary_configs" ADD CONSTRAINT "staff_salary_configs_user_role_id_user_roles_id_fk" FOREIGN KEY ("user_role_id") REFERENCES "public"."user_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salary_configs" ADD CONSTRAINT "staff_salary_configs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_payments_restaurant_id_idx" ON "payroll_payments" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "payroll_payments_user_role_id_idx" ON "payroll_payments" USING btree ("user_role_id");--> statement-breakpoint
CREATE INDEX "payroll_payments_paid_at_idx" ON "payroll_payments" USING btree ("paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_salary_configs_user_role_id_idx" ON "staff_salary_configs" USING btree ("user_role_id");--> statement-breakpoint
CREATE INDEX "staff_salary_configs_restaurant_id_idx" ON "staff_salary_configs" USING btree ("restaurant_id");