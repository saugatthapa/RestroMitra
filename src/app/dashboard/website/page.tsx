import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { WebsiteBuilderBoard } from "./WebsiteBuilderBoard";

export default async function WebsitePage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/website");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active = restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const canManage = roleHasPermission(active.role, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Website</h1>
        <p className="text-sm text-ink-muted">
          A free public page for {active.name} — hero, about, gallery, menu highlights, and contact
          info, with a QR code customers can scan to reach it.
        </p>
      </div>
      {canManage ? (
        <WebsiteBuilderBoard slug={active.slug} restaurantName={active.name} />
      ) : (
        <p className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted">
          You don&apos;t have permission to manage this restaurant&apos;s website. Ask an owner for
          access.
        </p>
      )}
    </div>
  );
}
