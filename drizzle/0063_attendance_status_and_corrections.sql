CREATE TYPE "public"."attendance_status" AS ENUM('needs_review', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "attendance_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attendance_record_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"corrected_by_user_id" uuid,
	"reason" text NOT NULL,
	"previous_clock_in_at" timestamp with time zone NOT NULL,
	"previous_clock_out_at" timestamp with time zone,
	"previous_note" text,
	"new_clock_in_at" timestamp with time zone NOT NULL,
	"new_clock_out_at" timestamp with time zone,
	"new_note" text,
	"corrected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "status" "attendance_status" DEFAULT 'verified' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_attendance_record_id_attendance_records_id_fk" FOREIGN KEY ("attendance_record_id") REFERENCES "public"."attendance_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_corrected_by_user_id_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_corrections_attendance_record_id_idx" ON "attendance_corrections" USING btree ("attendance_record_id");--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;