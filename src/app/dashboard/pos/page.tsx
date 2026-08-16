import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { POSOrderBuilder } from "./POSOrderBuilder";
import { OfflineServiceWorker } from "./OfflineServiceWorker";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

export default async function PosPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/pos");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const canCreateOrder = roleHasPermission(active.role, PERMISSIONS.CREATE_ORDER);
  // Phase 13 — only owner/manager can apply a discount or service charge at
  // order-creation time, same trust tier as APPLY_DISCOUNT everywhere else.
  const canApplyDiscount = roleHasPermission(active.role, PERMISSIONS.APPLY_DISCOUNT);
  // Phase 17 — attaching a loyalty customer and redeeming their points is
  // gated behind MANAGE_CUSTOMERS, same as the manual redemption action on
  // the Customers page (a cashier can do this by default; it's the
  // customer's own earned balance, not a discretionary discount).
  const canManageCustomers = roleHasPermission(active.role, PERMISSIONS.MANAGE_CUSTOMERS);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">POS</h1>
        <p className="text-sm text-neutral-500">
          Key in an order for a walk-in, phone, or dine-in table at {active.name} — priced from
          the live menu, same as QR ordering.
        </p>
      </div>

      {canCreateOrder ? (
        <>
          <OfflineServiceWorker />
          <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
            <POSOrderBuilder
              slug={active.slug}
              canApplyDiscount={canApplyDiscount}
              canManageCustomers={canManageCustomers}
            />
          </Suspense>
        </>
      ) : (
        <p className="rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
          Your role doesn&apos;t have permission to create orders.
        </p>
      )}
    </div>
  );
}
