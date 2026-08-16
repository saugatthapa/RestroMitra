import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { InventoryBoard } from "./InventoryBoard";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

export default async function InventoryPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/inventory");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  const canManage = roleHasPermission(active.role, PERMISSIONS.MANAGE_INVENTORY);

  if (!canManage) {
    return (
      <div>
        <h1 className="mb-2 text-xl font-semibold text-neutral-900">Inventory</h1>
        <p className="text-sm text-neutral-500">
          Your role ({active.role.replace("_", " ")}) doesn&apos;t have access to inventory
          management at {active.name}.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Inventory</h1>
        <p className="text-sm text-neutral-500">
          Stock items, suppliers, purchases, and recipes for {active.name}.
        </p>
      </div>
      <InventoryBoard
        slug={active.slug}
        canViewProfit={roleHasPermission(active.role, PERMISSIONS.VIEW_PROFIT)}
      />
    </div>
  );
}
