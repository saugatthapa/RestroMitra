-- Gap-audit P1 — database-level defense-in-depth backstop for branch/
-- restaurant tenant isolation. The application layer already validates a
-- requested branchId belongs to the requested restaurantId
-- (requireBranchAccess in src/lib/rbac/guard.ts), but nothing at the
-- schema level backed that up — a bug that skipped that check would have
-- been accepted silently by every table below.
--
-- branches.id is already a unique PK, so this composite UNIQUE(id,
-- restaurant_id) is free to add — it exists purely so every table below
-- can declare a composite FOREIGN KEY (branch_id, restaurant_id)
-- REFERENCES branches(id, restaurant_id), turning "this row's branch
-- actually belongs to this row's restaurant" into a hard, always-on
-- database guarantee. This constraint MUST be created before any of the
-- FKs referencing it below — Postgres requires a unique constraint (or
-- PK) on the referenced columns to exist before a foreign key can target
-- them, so drizzle-kit's alphabetical-by-table statement ordering (which
-- put this last, after tables starting with letters earlier than
-- "branches") had to be hand-reordered here.
ALTER TABLE "branches" ADD CONSTRAINT "branches_id_restaurant_id_unique" UNIQUE("id","restaurant_id");--> statement-breakpoint
-- Every table below has BOTH a restaurant_id and a branch_id (or, for
-- stock_transfers, from_branch_id/to_branch_id) column. Where the branch
-- column is nullable, Postgres's default MATCH SIMPLE means the
-- constraint is simply not checked for a row with a NULL branch column —
-- an unscoped/restaurant-wide row is unaffected, exactly as before this
-- migration.
--
-- Each FK's ON DELETE action mirrors that table's existing single-column
-- branch_id FK, with one deliberate exception: expenses uses "restrict"
-- here even though its own branch_id FK uses "set null" — a composite
-- FK's ON DELETE SET NULL would null out BOTH columns of the constraint
-- (branch_id AND restaurant_id) when a referenced branch is hard-deleted,
-- which would violate restaurant_id's own NOT NULL. Branches are never
-- hard-deleted anywhere in this codebase (soft-deleted via is_active), so
-- this never actually fires, but "restrict" is the only action that
-- can't corrupt this table if that ever changes.
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_events" ADD CONSTRAINT "realtime_events_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_shifts" ADD CONSTRAINT "register_shifts_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_calls" ADD CONSTRAINT "service_calls_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_restaurant_fk" FOREIGN KEY ("from_branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_restaurant_fk" FOREIGN KEY ("to_branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_branch_restaurant_fk" FOREIGN KEY ("branch_id","restaurant_id") REFERENCES "public"."branches"("id","restaurant_id") ON DELETE cascade ON UPDATE no action;
