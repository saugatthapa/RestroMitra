CREATE TYPE "public"."ledger_category" AS ENUM('sales', 'expense', 'purchase', 'due_settlement', 'capital', 'withdrawal', 'other');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."ledger_due_status" AS ENUM('none', 'outstanding', 'settled');--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"entry_date" date DEFAULT now() NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"category" "ledger_category" NOT NULL,
	"amount_in_paisa" integer NOT NULL,
	"counterparty_name" varchar(200),
	"description" varchar(300) NOT NULL,
	"note" text,
	"reference_type" varchar(40),
	"reference_id" uuid,
	"due_status" "ledger_due_status" DEFAULT 'none' NOT NULL,
	"settled_amount_in_paisa" integer DEFAULT 0 NOT NULL,
	"is_voided" boolean DEFAULT false NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_restaurant_id_idx" ON "ledger_entries" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_entry_date_idx" ON "ledger_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_due_status_idx" ON "ledger_entries" USING btree ("due_status");