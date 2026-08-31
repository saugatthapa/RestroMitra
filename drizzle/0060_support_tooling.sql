CREATE TABLE "restaurant_support_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"author_user_id" uuid,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restaurant_support_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"tag" varchar(40) NOT NULL,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restaurant_support_notes" ADD CONSTRAINT "restaurant_support_notes_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_support_notes" ADD CONSTRAINT "restaurant_support_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_support_tags" ADD CONSTRAINT "restaurant_support_tags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_support_tags" ADD CONSTRAINT "restaurant_support_tags_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restaurant_support_notes_restaurant_id_idx" ON "restaurant_support_notes" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "restaurant_support_notes_created_at_idx" ON "restaurant_support_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "restaurant_support_tags_restaurant_id_idx" ON "restaurant_support_tags" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "restaurant_support_tags_restaurant_id_tag_unique" ON "restaurant_support_tags" USING btree ("restaurant_id","tag");