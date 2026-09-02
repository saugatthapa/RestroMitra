ALTER TABLE "attendance_records" ADD COLUMN "clock_in_workplace_photo_object_key" varchar(500);--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "clock_out_workplace_photo_object_key" varchar(500);--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "workplace_photo_required" boolean DEFAULT false NOT NULL;