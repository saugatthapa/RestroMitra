import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { ExpensesBoard } from "./ExpensesBoard";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

export default async function ExpensesPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/expenses");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Expenses</h1>
        <p className="text-sm text-neutral-500">
          Operational spending for {active.name}.
        </p>
      </div>
      <ExpensesBoard
        slug={active.slug}
        canManageExpenses={roleHasPermission(active.role, PERMISSIONS.MANAGE_EXPENSES)}
      />
    </div>
  );
}
