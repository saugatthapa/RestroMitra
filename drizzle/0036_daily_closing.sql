CREATE TABLE "daily_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"closed_by_user_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revenue_in_paisa" integer NOT NULL,
	"cogs_in_paisa" integer NOT NULL,
	"net_profit_in_paisa" integer NOT NULL,
	"cash_variance_in_paisa" integer,
	"notes" text,
	"snapshot_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_closes_restaurant_id_idx" ON "daily_closes" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "daily_closes_branch_id_idx" ON "daily_closes" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_closes_restaurant_branch_date_unique" ON "daily_closes" USING btree ("restaurant_id","branch_id","business_date");