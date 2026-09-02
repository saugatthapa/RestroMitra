import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { TablesView } from "./TablesView";

export default async function TablesPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/tables");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without MANAGE_TABLES shouldn't reach this page at all — the
  // sidebar already hides the nav link (DashboardShell); this redirect is
  // what actually enforces it against a direct URL hit.
  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_TABLES)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Tables &amp; QR</h1>
        <p className="text-sm text-ink-muted">
          Create a table, print its QR code, and place it on the physical table. Customers
          scan it to browse the menu and order directly — no app or login needed.
        </p>
      </div>
      <TablesView slug={active.slug} restaurantName={active.name} />
    </div>
  );
}
