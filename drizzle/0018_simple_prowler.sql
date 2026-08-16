ALTER TABLE "customers" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "current_visit_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "longest_visit_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_visit_date" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_birthday_bonus_year" integer;