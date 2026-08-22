-- Defensive backfill before the constraint below: the app has enforced
-- "at most one active grant per (user, restaurant)" at every INSERT since
-- launch, but the staff PATCH route's reactivation path did NOT enforce it
-- (see guard.ts / staff/[userRoleId]/route.ts comments) until this same
-- migration's application code caught up. If that gap was ever actually
-- hit in production, CREATE UNIQUE INDEX below would fail outright against
-- existing duplicate rows -- so any duplicates are resolved here first by
-- keeping only the most-recently-created active grant per (user,
-- restaurant) and deactivating the rest. This is a no-op (matches zero
-- rows) on any database where the gap was never actually hit.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, restaurant_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM "user_roles"
  WHERE is_active = true AND restaurant_id IS NOT NULL
)
UPDATE "user_roles"
SET is_active = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_one_active_per_restaurant_unique" ON "user_roles" USING btree ("user_id","restaurant_id") WHERE "user_roles"."is_active" = true AND "user_roles"."restaurant_id" IS NOT NULL;