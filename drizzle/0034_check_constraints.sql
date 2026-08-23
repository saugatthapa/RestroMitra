ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_positive" CHECK ("expenses"."amount_in_paisa" > 0);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_reorder_level_non_negative" CHECK ("inventory_items"."reorder_level_milliunits" IS NULL OR "inventory_items"."reorder_level_milliunits" >= 0);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_cost_non_negative" CHECK ("inventory_items"."cost_per_unit_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative" CHECK (
      "orders"."subtotal_in_paisa" >= 0 AND "orders"."tax_in_paisa" >= 0 AND
      "orders"."discount_in_paisa" >= 0 AND "orders"."service_charge_in_paisa" >= 0 AND
      "orders"."total_in_paisa" >= 0
    );--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_amount_positive" CHECK ("payroll_payments"."amount_in_paisa" > 0);--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_quantity_positive" CHECK ("purchase_items"."quantity_milliunits" > 0);--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_unit_cost_non_negative" CHECK ("purchase_items"."unit_cost_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_line_total_non_negative" CHECK ("purchase_items"."line_total_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_total_non_negative" CHECK ("purchases"."total_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_party_size_positive" CHECK ("reservations"."party_size" > 0);--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_capacity_positive" CHECK ("restaurant_tables"."capacity" IS NULL OR "restaurant_tables"."capacity" > 0);--> statement-breakpoint
ALTER TABLE "staff_salary_configs" ADD CONSTRAINT "staff_salary_configs_amount_positive" CHECK ("staff_salary_configs"."amount_in_paisa" > 0);