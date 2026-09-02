import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { AccountBooksBoard } from "./AccountBooksBoard";

export default async function AccountBooksPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/account-books");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without MANAGE_ACCOUNT_BOOKS shouldn't reach this page at all —
  // the sidebar already hides the nav link (DashboardShell); this redirect
  // is what actually enforces it against a direct URL hit.
  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_ACCOUNT_BOOKS)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Account Books</h1>
        <p className="text-sm text-neutral-500">
          Day, month, and year cash books for {active.name} — money actually in and out, plus who
          still owes whom. Distinct from Reports&apos; sales/profit figures, which count completed
          order totals rather than cash movement.
        </p>
      </div>
      <AccountBooksBoard
        slug={active.slug}
        canManage={roleHasPermission(active.role, PERMISSIONS.MANAGE_ACCOUNT_BOOKS)}
      />
    </div>
  );
}
