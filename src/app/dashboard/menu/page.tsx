import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { MenuManager } from "./MenuManager";

export default async function MenuPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/menu");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without EDIT_MENU shouldn't reach this management board at all
  // — the sidebar already hides the nav link (DashboardShell); this
  // redirect is what actually enforces it against a direct URL hit. (The
  // live menu customers/POS order from is a separate read path, unaffected
  // by this — this page is specifically the categories/items/prices CRUD
  // board.)
  if (!roleHasPermission(active.role, PERMISSIONS.EDIT_MENU)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Menu</h1>
        <p className="text-sm text-ink-muted">
          Categories, items, variants, and add-ons for {active.name}.
        </p>
      </div>
      <MenuManager slug={active.slug} canEditPrice={active.role === "owner"} />
    </div>
  );
}
