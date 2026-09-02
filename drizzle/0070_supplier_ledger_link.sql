ALTER TABLE "ledger_entries" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_supplier_id_idx" ON "ledger_entries" USING btree ("supplier_id");--> statement-breakpoint
-- Backfill (Supplier Statement, Gap Audit P1): every purchase-category
-- ledger entry recorded BEFORE this migration has no supplier_id yet (only
-- code shipped after this point stamps it via recordPurchaseLedgerEntry —
-- see that function's own comment). getSupplierStatement filters on
-- supplier_id directly rather than joining back through purchases, so
-- without this backfill every historical purchase/payment would silently
-- vanish from a supplier's statement even though it's still perfectly
-- live in the due report (which DOES join through purchases). Run in two
-- passes since a due_settlement entry's own reference_id points at the
-- ORIGINAL purchase entry, not at the purchase row itself — the first
-- pass must land before the second pass can read it back off that
-- already-backfilled original.
UPDATE "ledger_entries" le
SET "supplier_id" = p."supplier_id"
FROM "purchases" p
WHERE le."reference_type" = 'purchase'
  AND le."reference_id" = p."id"
  AND p."supplier_id" IS NOT NULL
  AND le."supplier_id" IS NULL;--> statement-breakpoint
UPDATE "ledger_entries" le
SET "supplier_id" = orig."supplier_id"
FROM "ledger_entries" orig
WHERE le."reference_type" = 'due_settlement'
  AND le."reference_id" = orig."id"
  AND orig."supplier_id" IS NOT NULL
  AND le."supplier_id" IS NULL;