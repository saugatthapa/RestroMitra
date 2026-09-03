CREATE TABLE "platform_verification_contact" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"instagram_url" text,
	"tiktok_url" text,
	"whatsapp_number" varchar(32),
	"message" text,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "verified_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "verified_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_verification_contact" ADD CONSTRAINT "platform_verification_contact_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;