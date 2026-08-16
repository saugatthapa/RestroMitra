import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { OrderBillView } from "./OrderBillView";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/orders");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const { orderId } = await params;

  return (
    <OrderBillView
      slug={active.slug}
      orderId={orderId}
      canEdit={roleHasPermission(active.role, PERMISSIONS.EDIT_ORDER)}
      canCancel={roleHasPermission(active.role, PERMISSIONS.CANCEL_ORDER)}
      canRefund={roleHasPermission(active.role, PERMISSIONS.REFUND_ORDER)}
      canApplyDiscount={roleHasPermission(active.role, PERMISSIONS.APPLY_DISCOUNT)}
    />
  );
}
