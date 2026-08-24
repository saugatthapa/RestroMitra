ALTER TABLE "payments" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciled_fields_consistent" CHECK (("payments"."reconciled_at" IS NULL AND "payments"."reconciled_by_user_id" IS NULL)
          OR ("payments"."reconciled_at" IS NOT NULL AND "payments"."reconciled_by_user_id" IS NOT NULL));