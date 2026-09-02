import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { ReportsBoard } from "./ReportsBoard";

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/reports");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  if (!roleHasPermission(active.role, PERMISSIONS.VIEW_REPORTS)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Reports</h1>
        <p className="text-sm text-ink-muted">
          Sales, expenses, and profit for {active.name}.
        </p>
      </div>
      <ReportsBoard
        slug={active.slug}
        canViewProfit={roleHasPermission(active.role, PERMISSIONS.VIEW_PROFIT)}
      />
    </div>
  );
}
