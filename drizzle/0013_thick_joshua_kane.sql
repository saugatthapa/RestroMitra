CREATE TYPE "public"."payment_gateway" AS ENUM('esewa', 'khalti');--> statement-breakpoint
CREATE TYPE "public"."payment_gateway_transaction_status" AS ENUM('initiated', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "payment_gateway_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"gateway" "payment_gateway" NOT NULL,
	"status" "payment_gateway_transaction_status" DEFAULT 'initiated' NOT NULL,
	"amount_in_paisa" integer NOT NULL,
	"gateway_reference" varchar(100) NOT NULL,
	"gateway_transaction_id" varchar(150),
	"raw_response" jsonb,
	"payment_id" uuid,
	"initiated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_gateway_transactions" ADD CONSTRAINT "payment_gateway_transactions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_transactions" ADD CONSTRAINT "payment_gateway_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_transactions" ADD CONSTRAINT "payment_gateway_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_transactions" ADD CONSTRAINT "payment_gateway_transactions_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_gateway_transactions_restaurant_id_idx" ON "payment_gateway_transactions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "payment_gateway_transactions_order_id_idx" ON "payment_gateway_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_gateway_transactions_restaurant_reference_unique" ON "payment_gateway_transactions" USING btree ("restaurant_id","gateway_reference");