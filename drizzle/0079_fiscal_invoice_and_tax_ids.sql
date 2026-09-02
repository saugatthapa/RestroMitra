CREATE TABLE "fiscal_invoice_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fiscal_invoice_number" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fiscal_invoice_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "pan_number" varchar(20);--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "vat_number" varchar(20);--> statement-breakpoint
ALTER TABLE "fiscal_invoice_counters" ADD CONSTRAINT "fiscal_invoice_counters_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_invoice_counters_restaurant_unique" ON "fiscal_invoice_counters" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_restaurant_fiscal_invoice_number_unique" ON "orders" USING btree ("restaurant_id","fiscal_invoice_number") WHERE "orders"."fiscal_invoice_number" IS NOT NULL;