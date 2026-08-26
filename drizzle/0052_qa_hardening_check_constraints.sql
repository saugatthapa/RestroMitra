ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_discount_non_negative" CHECK ("coupon_redemptions"."discount_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_discount_value_non_negative" CHECK ("coupons"."discount_value" >= 0);--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_max_discount_non_negative" CHECK ("coupons"."max_discount_in_paisa" IS NULL OR "coupons"."max_discount_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_min_order_subtotal_non_negative" CHECK ("coupons"."min_order_subtotal_in_paisa" IS NULL OR "coupons"."min_order_subtotal_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_usage_limit_non_negative" CHECK ("coupons"."usage_limit" IS NULL OR "coupons"."usage_limit" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount_in_paisa" > 0);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_settled_amount_non_negative" CHECK ("ledger_entries"."settled_amount_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "menu_addons" ADD CONSTRAINT "menu_addons_price_non_negative" CHECK ("menu_addons"."price_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_base_price_non_negative" CHECK ("menu_items"."base_price_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "menu_variants" ADD CONSTRAINT "menu_variants_price_non_negative" CHECK ("menu_variants"."price_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "payment_gateway_transactions" ADD CONSTRAINT "payment_gateway_transactions_amount_positive" CHECK ("payment_gateway_transactions"."amount_in_paisa" > 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tip_non_negative" CHECK ("payments"."tip_in_paisa" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_non_negative" CHECK ("payments"."received_in_paisa" IS NULL OR "payments"."received_in_paisa" >= 0);