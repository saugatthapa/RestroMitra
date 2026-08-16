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

  // Staff roster/attendance is management-only data (contact info, pay-
  // adjacent attendance records) — a role without MANAGE_STAFF shouldn't
  // reach this page at all, not just see a read-only version of it. The
  // sidebar (DashboardShell) already hides the nav link for these roles;
  // this redirect is what actually enforces it if someone hits the URL
  // directly.
  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_STAFF)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Staff</h1>
        <p className="text-sm text-neutral-500">
          Team roster and attendance for {active.name}.
        </p>
      </div>
      <StaffBoard slug={active.slug} canManageStaff={roleHasPermission(active.role, PERMISSIONS.MANAGE_STAFF)} />
    </div>
  );
}
