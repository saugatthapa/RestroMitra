import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { StaffBoard } from "./StaffBoard";

export default async function StaffPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/staff");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  const canManageStaff = roleHasPermission(active.role, PERMISSIONS.MANAGE_STAFF);
  const canViewPayroll = roleHasPermission(active.role, PERMISSIONS.VIEW_PAYROLL);
  const canManagePayroll = roleHasPermission(active.role, PERMISSIONS.MANAGE_PAYROLL);
  // Phase 12 (Attendance overhaul, Track B) — the selfie-clock-in toggle
  // lives behind MANAGE_RESTAURANT_SETTINGS, not MANAGE_STAFF (same
  // "structural configuration" trust tier as kot-settings/branches), so a
  // manager who can run the roster still can't flip this on/off.
  const canManageAttendanceSettings = roleHasPermission(active.role, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS);

  // Phase 22 — this page now serves two different, deliberately separate
  // permission grants: MANAGE_STAFF (Roster/Attendance) and VIEW_PAYROLL/
  // MANAGE_PAYROLL (Payroll tab). An accountant holds the latter but NOT
  // the former (see permissions.ts — salary access is intentionally never
  // bundled with staff/roster management), so the gate below is an "any
  // of" check; StaffBoard itself only renders the tab(s) the caller
  // actually has rights to. The sidebar (DashboardShell) mirrors this same
  // any-of rule for the nav link.
  if (!canManageStaff && !canViewPayroll && !canManagePayroll) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Staff</h1>
        <p className="text-sm text-ink-muted">
          Team roster, attendance, and payroll for {active.name}.
        </p>
      </div>
      <StaffBoard
        slug={active.slug}
        canManageStaff={canManageStaff}
        canViewPayroll={canViewPayroll}
        canManagePayroll={canManagePayroll}
        canManageAttendanceSettings={canManageAttendanceSettings}
      />
    </div>
  );
}
