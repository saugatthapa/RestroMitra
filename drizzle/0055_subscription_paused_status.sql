ALTER TYPE "public"."subscription_event_type" ADD VALUE 'trial_shortened';--> statement-breakpoint
ALTER TYPE "public"."subscription_event_type" ADD VALUE 'paused';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'paused' BEFORE 'cancelled';