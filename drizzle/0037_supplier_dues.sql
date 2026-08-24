ALTER TABLE "purchases" ADD COLUMN "is_credit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "is_voided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "voided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_voided_fields_consistent" CHECK (("purchases"."is_voided" = false AND "purchases"."voided_at" IS NULL AND "purchases"."voided_by_user_id" IS NULL)
          OR
          ("purchases"."is_voided" = true AND "purchases"."voided_at" IS NOT NULL));