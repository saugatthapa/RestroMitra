CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(40) NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"model" varchar(100) NOT NULL,
	"api_url" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"provider" varchar(40) NOT NULL,
	"model" varchar(100) NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_in_paisa" integer,
	"success" boolean NOT NULL,
	"error_message" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "ai_monthly_request_limit" integer;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "ai_monthly_request_limit_override" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_configs_provider_unique" ON "ai_provider_configs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_restaurant_id_idx" ON "ai_usage_logs" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_created_at_idx" ON "ai_usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_restaurant_id_created_at_idx" ON "ai_usage_logs" USING btree ("restaurant_id","created_at");--> statement-breakpoint
-- Seed a starting AI monthly-request limit for the 3 catalog plans (see
-- drizzle/0056_plan_catalog_table.sql's own seed). starter doesn't carry
-- the ai_assistant feature key at all, so its limit is moot (hasFeature()
-- gates it out before the quota is ever checked) — left NULL/unlimited
-- rather than picking an arbitrary number that will never be read. growth
-- gets a real cap (200/mo — generous for a single owner/manager checking
-- numbers a few times a day, well inside Groq's free tier); pro is
-- unlimited (NULL), matching its "everything unlimited" positioning
-- (unlimited staff/branches — see plans.maxStaff/maxBranches above).
UPDATE "plans" SET "ai_monthly_request_limit" = 200 WHERE "key" = 'growth';