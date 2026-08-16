import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { WebsiteBuilderBoard } from "./WebsiteBuilderBoard";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

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
        <h1 className="text-xl font-semibold text-neutral-900">Website</h1>
        <p className="text-sm text-neutral-500">
          A free public page for {active.name} — hero, about, gallery, menu highlights, and contact
          info, with a QR code customers can scan to reach it.
        </p>
      </div>
      {canManage ? (
        <WebsiteBuilderBoard slug={active.slug} />
      ) : (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">
          You don&apos;t have permission to manage this restaurant&apos;s website. Ask an owner for
          access.
        </p>
      )}
    </div>
  );
}
