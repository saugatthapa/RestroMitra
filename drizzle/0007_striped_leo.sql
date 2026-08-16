CREATE TYPE "public"."loyalty_transaction_type" AS ENUM('earn', 'redeem', 'adjustment');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"phone" varchar(20) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"email" varchar(255),
	"notes" text,
	"loyalty_points_balance" integer DEFAULT 0 NOT NULL,
	"lifetime_points_earned" integer DEFAULT 0 NOT NULL,
	"total_orders_count" integer DEFAULT 0 NOT NULL,
	"total_spent_in_paisa" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" "loyalty_transaction_type" NOT NULL,
	"points_delta" integer NOT NULL,
	"reference_type" varchar(40),
	"reference_id" uuid,
	"note" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_restaurant_id_idx" ON "customers" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_restaurant_phone_unique" ON "customers" USING btree ("restaurant_id","phone");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_restaurant_id_idx" ON "loyalty_transactions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_customer_id_idx" ON "loyalty_transactions" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;