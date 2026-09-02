import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { CouponsBoard } from "./CouponsBoard";

export default async function CouponsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/coupons");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without APPLY_DISCOUNT shouldn't reach this page at all — the
  // sidebar already hides the nav link (DashboardShell); this redirect is
  // what actually enforces it against a direct URL hit. Coupons share
  // APPLY_DISCOUNT with manual discounts (see coupons/route.ts's own
  // comment) — a reusable code is just another way to grant a discount.
  if (!roleHasPermission(active.role, PERMISSIONS.APPLY_DISCOUNT)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Coupons</h1>
        <p className="text-sm text-ink-muted">
          Reusable promo codes staff can apply at checkout for {active.name}.
        </p>
      </div>
      <CouponsBoard slug={active.slug} />
    </div>
  );
}
