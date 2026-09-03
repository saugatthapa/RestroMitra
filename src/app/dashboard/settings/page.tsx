import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { SettingsBoard } from "./SettingsBoard";

// The Settings nav item (see DashboardShell.tsx) was a permanent "Coming
// soon" placeholder — this is the real page it points to now. Same
// page-level guard pattern as /dashboard/branches: MANAGE_RESTAURANT_SETTINGS
// is owner-only by default, so a role that can't manage settings never
// lands here at all (the nav item itself is already hidden from them too).
export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/settings");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active = restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS)) {
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Settings</h1>
        <p className="text-sm text-neutral-500">
          {active.name}&apos;s profile, tax details, and kitchen ticket header.
        </p>
      </div>
      <SettingsBoard slug={active.slug} />
    </div>
  );
}
