import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { CustomersBoard } from "./CustomersBoard";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

export default async function CustomersPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/customers");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Customers</h1>
        <p className="text-sm text-neutral-500">
          CRM and loyalty program for {active.name}.
        </p>
      </div>
      <CustomersBoard
        slug={active.slug}
        canManageCustomers={roleHasPermission(active.role, PERMISSIONS.MANAGE_CUSTOMERS)}
      />
    </div>
  );
}
