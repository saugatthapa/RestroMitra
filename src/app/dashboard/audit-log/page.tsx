import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { AuditLogBoard } from "./AuditLogBoard";

// RC audit P1 fix — see the API route's own doc comment
// (src/app/api/restaurants/[slug]/audit-log/route.ts) for why this page
// exists: recordAuditLog() has been populating audit_logs since Phase 2
// with zero read path until now.
export default async function AuditLogPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/audit-log");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // Same trust tier as the Staff page (DashboardShell gates the nav link
  // the same way) — the log surfaces exactly the kind of staff-permission/
  // role/salary changes that page already gates. This redirect is what
  // actually enforces it against a direct URL hit.
  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_STAFF)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Activity Log</h1>
        <p className="text-sm text-ink-muted">
          A record of sensitive actions taken across {active.name} — refunds, staff and
          permission changes, settings changes, and more.
        </p>
      </div>
      <AuditLogBoard slug={active.slug} />
    </div>
  );
}
