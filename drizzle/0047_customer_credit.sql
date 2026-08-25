ALTER TABLE "customers" ADD COLUMN "credit_limit_in_paisa" integer;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_customer_id_idx" ON "ledger_entries" USING btree ("customer_id");