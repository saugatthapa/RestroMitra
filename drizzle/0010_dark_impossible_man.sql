CREATE TYPE "public"."plan_key" AS ENUM('starter', 'growth', 'pro');--> statement-breakpoint
CREATE TYPE "public"."subscription_event_type" AS ENUM('trial_started', 'trial_extended', 'trial_expired', 'upgrade_requested', 'plan_assigned', 'plan_changed', 'activated', 'past_due_marked', 'cancelled', 'reactivated');--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"event_type" "subscription_event_type" NOT NULL,
	"from_status" "subscription_status",
	"to_status" "subscription_status",
	"plan_key" "plan_key",
	"note" text,
	"performed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "plan_key" "plan_key";--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_events_restaurant_id_idx" ON "subscription_events" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "subscription_events_created_at_idx" ON "subscription_events" USING btree ("created_at");