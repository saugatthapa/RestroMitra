import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { OrderBillView } from "./OrderBillView";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

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
