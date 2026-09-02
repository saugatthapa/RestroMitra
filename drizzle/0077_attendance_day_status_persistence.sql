CREATE TYPE "public"."attendance_day_status" AS ENUM('present', 'late', 'no_show', 'on_leave', 'holiday');--> statement-breakpoint
CREATE TABLE "attendance_day_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_id" uuid,
	"date" date NOT NULL,
	"status" "attendance_day_status" NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_day_statuses" ADD CONSTRAINT "attendance_day_statuses_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_day_statuses" ADD CONSTRAINT "attendance_day_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_day_statuses" ADD CONSTRAINT "attendance_day_statuses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_day_statuses_restaurant_id_idx" ON "attendance_day_statuses" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "attendance_day_statuses_user_id_idx" ON "attendance_day_statuses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attendance_day_statuses_date_idx" ON "attendance_day_statuses" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_day_statuses_restaurant_user_date_unique" ON "attendance_day_statuses" USING btree ("restaurant_id","user_id","date");