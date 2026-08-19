ALTER TABLE "expenses" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" DROP COLUMN "category";--> statement-breakpoint
DROP TYPE "public"."expense_category";