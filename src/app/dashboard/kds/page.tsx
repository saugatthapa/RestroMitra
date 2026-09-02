import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { KDSBoard } from "./KDSBoard";
import { KotSettingsPanel } from "./KotSettingsPanel";

export default async function KDSPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/kds");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Kitchen (KDS)</h1>
          <p className="text-sm text-ink-muted">
            Live tickets for {active.name}, grouped by station — confirmed orders waiting to
            start, orders in progress, and orders ready for pickup/service.
          </p>
        </div>
        {roleHasPermission(active.role, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS) && (
          <KotSettingsPanel slug={active.slug} />
        )}
      </div>
      <KDSBoard
        slug={active.slug}
        canAdvance={
          roleHasPermission(active.role, PERMISSIONS.UPDATE_KDS_STATUS) ||
          roleHasPermission(active.role, PERMISSIONS.EDIT_ORDER)
        }
      />
    </div>
  );
}
