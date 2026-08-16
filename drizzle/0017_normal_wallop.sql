CREATE TABLE "kot_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"ticket_date" varchar(10) NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "kot_sequence" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "kot_printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "kot_header_text" varchar(200);--> statement-breakpoint
ALTER TABLE "kot_counters" ADD CONSTRAINT "kot_counters_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kot_counters_restaurant_date_unique" ON "kot_counters" USING btree ("restaurant_id","ticket_date");