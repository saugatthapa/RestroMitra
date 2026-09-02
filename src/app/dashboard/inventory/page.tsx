import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { InventoryBoard } from "./InventoryBoard";

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
        canManageAccountBooks={roleHasPermission(active.role, PERMISSIONS.MANAGE_ACCOUNT_BOOKS)}
        canApproveStockCount={roleHasPermission(active.role, PERMISSIONS.APPROVE_STOCK_COUNT)}
        canManageRestaurantSettings={roleHasPermission(active.role, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS)}
      />
    </div>
  );
}
