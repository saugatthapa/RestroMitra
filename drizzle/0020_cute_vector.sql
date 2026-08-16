CREATE TYPE "public"."website_theme" AS ENUM('classic', 'modern', 'warm', 'midnight');--> statement-breakpoint
CREATE TABLE "restaurant_websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"theme" "website_theme" DEFAULT 'classic' NOT NULL,
	"tagline" varchar(200),
	"about_text" text,
	"hero_image_url" text,
	"gallery_image_urls" jsonb,
	"show_menu_section" boolean DEFAULT true NOT NULL,
	"featured_menu_item_ids" jsonb,
	"social_links" jsonb,
	"contact_phone" varchar(20),
	"contact_address" text,
	"seo_title" varchar(200),
	"seo_description" varchar(300),
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restaurant_websites" ADD CONSTRAINT "restaurant_websites_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restaurant_websites_restaurant_id_unique" ON "restaurant_websites" USING btree ("restaurant_id");