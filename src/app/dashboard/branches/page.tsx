import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { BranchesBoard } from "./BranchesBoard";

export default async function BranchesPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/branches");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_BRANCHES)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Branches</h1>
        <p className="text-sm text-ink-muted">
          Manage {active.name}&apos;s physical locations. Staff, tables, and orders can be
          scoped to a specific branch.
        </p>
      </div>
      <BranchesBoard slug={active.slug} />
    </div>
  );
}
