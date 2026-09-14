CREATE TABLE "fiscal_credit_note_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fiscal_credit_note_number" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fiscal_credit_note_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fiscal_credit_note_counters" ADD CONSTRAINT "fiscal_credit_note_counters_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_credit_note_counters_restaurant_unique" ON "fiscal_credit_note_counters" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_restaurant_fiscal_credit_note_number_unique" ON "payments" USING btree ("restaurant_id","fiscal_credit_note_number") WHERE "payments"."fiscal_credit_note_number" IS NOT NULL;