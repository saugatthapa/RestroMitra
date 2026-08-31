-- Phase 17 (Attendance overhaul, Track B — plan-gated attendance tiers).
--
-- Adds the `staff_attendance` feature key (reserved since drizzle/0056,
-- never referenced by any plan's feature_keys until now) to Growth and
-- Pro's feature_keys — the same two tiers `payroll` already sits on,
-- since attendance's main integration point is payroll (Phase 16).
-- Starter stays without it, matching every other Growth+/Pro-only
-- capability (inventory, customers/loyalty, ai_assistant, website_builder,
-- payroll — see the seed data in 0056_plan_catalog_table.sql).
--
-- This key gates only the ADVANCED attendance suite built in Phases
-- 12-16: selfie photo verification + owner review, leave/holiday
-- management, staff scheduling, and attendance analytics. It deliberately
-- does NOT gate plain clock-in/clock-out (with an optional note, no
-- photo) — that predates this feature key and every existing restaurant,
-- on every plan, already has it; retroactively paywalling something
-- customers already use is out of scope for this phase. See
-- feature-catalog.ts's own comment on STAFF_ATTENDANCE and the
-- requireFeature() call sites in the attendance/leave-requests/holidays/
-- schedule routes for exactly which endpoints check it.
--
-- A plain data UPDATE, not a schema change — no drizzle-kit-generated
-- statement here, hand-written the same way 0058's own
-- `UPDATE "plans" SET "ai_monthly_request_limit" = 200 WHERE "key" =
-- 'growth'` was. Guarded with a jsonb containment check so re-running
-- this file (it won't be — drizzle-orm's migrator tracks applied
-- migrations by hash — but belt-and-braces matches this project's own
-- idempotency convention, see 0051_qa_hardening_idempotency_and_indexes.sql)
-- is a no-op the second time rather than appending a duplicate key.
UPDATE "plans"
SET "feature_keys" = "feature_keys" || '["staff_attendance"]'::jsonb,
    "features" = "features" || '["Staff attendance, leave & scheduling (selfie-verified)"]'::jsonb
WHERE "key" IN ('growth', 'pro')
  AND NOT ("feature_keys" @> '["staff_attendance"]'::jsonb);
