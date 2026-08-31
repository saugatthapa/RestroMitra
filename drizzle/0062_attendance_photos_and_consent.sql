CREATE TABLE "attendance_photo_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"consent_version" varchar(40) NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "clock_in_photo_object_key" varchar(500);--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "clock_out_photo_object_key" varchar(500);--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "selfie_clock_in_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_photo_consents" ADD CONSTRAINT "attendance_photo_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_photo_consents" ADD CONSTRAINT "attendance_photo_consents_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_photo_consents_user_restaurant_idx" ON "attendance_photo_consents" USING btree ("user_id","restaurant_id");