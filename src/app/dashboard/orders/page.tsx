import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { OrdersBoard } from "./OrdersBoard";

export default async function OrdersPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/orders");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Orders</h1>
        <p className="text-sm text-neutral-500">
          Live orders for {active.name} — from QR ordering today, and every other
          source (POS, waiter) once those phases ship, all through the same board.
        </p>
      </div>
      <OrdersBoard
        slug={active.slug}
        canEdit={roleHasPermission(active.role, PERMISSIONS.EDIT_ORDER)}
        canCancel={roleHasPermission(active.role, PERMISSIONS.CANCEL_ORDER)}
      />
    </div>
  );
}
