ALTER TABLE "expenses" ADD COLUMN "client_request_id" varchar(100);--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD COLUMN "client_request_id" varchar(100);--> statement-breakpoint
CREATE INDEX "audit_logs_restaurant_id_created_at_idx" ON "audit_logs" USING btree ("restaurant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_restaurant_client_request_id_unique" ON "expenses" USING btree ("restaurant_id","client_request_id") WHERE "expenses"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_restaurant_id_placed_at_idx" ON "orders" USING btree ("restaurant_id","placed_at");--> statement-breakpoint
CREATE INDEX "payments_restaurant_id_created_at_idx" ON "payments" USING btree ("restaurant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payments_restaurant_client_request_id_unique" ON "payroll_payments" USING btree ("restaurant_id","client_request_id") WHERE "payroll_payments"."client_request_id" IS NOT NULL;