CREATE TYPE "public"."register_cash_movement_type" AS ENUM('addition', 'drop', 'payout');--> statement-breakpoint
CREATE TYPE "public"."register_shift_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "register_cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"type" "register_cash_movement_type" NOT NULL,
	"amount_in_paisa" integer NOT NULL,
	"reason" varchar(300),
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_cash_movements_amount_positive" CHECK ("register_cash_movements"."amount_in_paisa" > 0)
);
--> statement-breakpoint
CREATE TABLE "register_shift_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"corrected_by_user_id" uuid NOT NULL,
	"previous_actual_cash_in_paisa" integer NOT NULL,
	"new_actual_cash_in_paisa" integer NOT NULL,
	"previous_variance_in_paisa" integer NOT NULL,
	"new_variance_in_paisa" integer NOT NULL,
	"reason" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "register_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_name" varchar(60) DEFAULT 'Main Register' NOT NULL,
	"status" "register_shift_status" DEFAULT 'open' NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_cash_in_paisa" integer NOT NULL,
	"opening_notes" text,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"actual_cash_in_paisa" integer,
	"expected_cash_in_paisa" integer,
	"variance_in_paisa" integer,
	"closing_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_shifts_opening_cash_non_negative" CHECK ("register_shifts"."opening_cash_in_paisa" >= 0),
	CONSTRAINT "register_shifts_actual_cash_non_negative" CHECK ("register_shifts"."actual_cash_in_paisa" IS NULL OR "register_shifts"."actual_cash_in_paisa" >= 0),
	CONSTRAINT "register_shifts_closed_fields_consistent" CHECK (("register_shifts"."status" = 'open' AND "register_shifts"."closed_by_user_id" IS NULL AND "register_shifts"."closed_at" IS NULL AND "register_shifts"."actual_cash_in_paisa" IS NULL AND "register_shifts"."expected_cash_in_paisa" IS NULL AND "register_shifts"."variance_in_paisa" IS NULL)
          OR
          ("register_shifts"."status" = 'closed' AND "register_shifts"."closed_at" IS NOT NULL AND "register_shifts"."actual_cash_in_paisa" IS NOT NULL AND "register_shifts"."expected_cash_in_paisa" IS NOT NULL AND "register_shifts"."variance_in_paisa" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "register_cash_movements" ADD CONSTRAINT "register_cash_movements_shift_id_register_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."register_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_cash_movements" ADD CONSTRAINT "register_cash_movements_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shift_corrections" ADD CONSTRAINT "register_shift_corrections_shift_id_register_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."register_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shift_corrections" ADD CONSTRAINT "register_shift_corrections_corrected_by_user_id_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shifts" ADD CONSTRAINT "register_shifts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shifts" ADD CONSTRAINT "register_shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shifts" ADD CONSTRAINT "register_shifts_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shifts" ADD CONSTRAINT "register_shifts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "register_cash_movements_shift_id_idx" ON "register_cash_movements" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "register_shift_corrections_shift_id_idx" ON "register_shift_corrections" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "register_shifts_restaurant_id_idx" ON "register_shifts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "register_shifts_branch_id_idx" ON "register_shifts" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "register_shifts_status_idx" ON "register_shifts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "register_shifts_one_open_per_cashier" ON "register_shifts" USING btree ("opened_by_user_id") WHERE "register_shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "register_shifts_one_open_per_branch_register" ON "register_shifts" USING btree ("branch_id","register_name") WHERE "register_shifts"."status" = 'open';