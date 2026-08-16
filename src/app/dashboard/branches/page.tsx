import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { BranchesBoard } from "./BranchesBoard";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

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
        <h1 className="text-xl font-semibold text-neutral-900">Branches</h1>
        <p className="text-sm text-neutral-500">
          Manage {active.name}&apos;s physical locations. Staff, tables, and orders can be
          scoped to a specific branch.
        </p>
      </div>
      <BranchesBoard slug={active.slug} />
    </div>
  );
}
