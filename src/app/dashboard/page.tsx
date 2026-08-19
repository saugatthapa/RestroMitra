import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { DashboardStats } from "./DashboardStats";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // Only used for the intro paragraph's wording below — the actual
  // permission-gated data fetching for the stat tiles/monthly block now
  // happens client-side in DashboardStats (see that file's comment for
  // why: it needs to react to the header's branch switcher, which a
  // server component can't see).
  const canViewReports = roleHasPermission(active.role, PERMISSIONS.VIEW_REPORTS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-900">
          Welcome back, {session.user.fullName.split(" ")[0]}
        </h1>
        <p className="text-sm text-neutral-500">
          Orders placed by customers show up on the{" "}
          <span className="font-medium text-neutral-700">Orders</span> board in real time
          (polling every few seconds) — move them through confirmed → preparing → ready →
          served → completed from there.
          {canViewReports && (
            <>
              {" "}
              Head to <span className="font-medium text-neutral-700">Reports</span> for revenue
              trends, top items, and peak-hour analytics.
            </>
          )}
        </p>
      </div>

      <DashboardStats slug={active.slug} />
    </div>
  );
}
