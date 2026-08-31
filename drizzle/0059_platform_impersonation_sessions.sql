CREATE TYPE "public"."impersonation_mode" AS ENUM('read_only', 'write');--> statement-breakpoint
CREATE TYPE "public"."impersonation_status" AS ENUM('active', 'ended', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "platform_impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"target_restaurant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"mode" "impersonation_mode" DEFAULT 'read_only' NOT NULL,
	"status" "impersonation_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_impersonation_sessions" ADD CONSTRAINT "platform_impersonation_sessions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_impersonation_sessions" ADD CONSTRAINT "platform_impersonation_sessions_target_restaurant_id_restaurants_id_fk" FOREIGN KEY ("target_restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_impersonation_sessions" ADD CONSTRAINT "platform_impersonation_sessions_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_impersonation_sessions_token_hash_unique" ON "platform_impersonation_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "platform_impersonation_sessions_admin_user_id_idx" ON "platform_impersonation_sessions" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "platform_impersonation_sessions_target_restaurant_id_idx" ON "platform_impersonation_sessions" USING btree ("target_restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_impersonation_sessions_one_active_per_admin_unique" ON "platform_impersonation_sessions" USING btree ("admin_user_id") WHERE "platform_impersonation_sessions"."status" = 'active';