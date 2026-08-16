ALTER TABLE "attendance_records" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_records_branch_id_idx" ON "attendance_records" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "reservations_branch_id_idx" ON "reservations" USING btree ("branch_id");