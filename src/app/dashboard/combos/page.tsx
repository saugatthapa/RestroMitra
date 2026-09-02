import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { CombosBoard } from "./CombosBoard";

export default async function CombosPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/combos");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without EDIT_MENU shouldn't reach this page at all — the
  // sidebar already hides the nav link (DashboardShell); this redirect is
  // what actually enforces it against a direct URL hit. Combos are gated
  // EDIT_MENU (same tier as menu items — see combos/route.ts's own
  // comment), not APPLY_DISCOUNT like Coupons/manual discounts.
  if (!roleHasPermission(active.role, PERMISSIONS.EDIT_MENU)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Combos</h1>
        <p className="text-sm text-neutral-500">
          Bundle menu items at a fixed price for staff to add to an order at the POS for{" "}
          {active.name}.
        </p>
      </div>
      <CombosBoard slug={active.slug} />
    </div>
  );
}
