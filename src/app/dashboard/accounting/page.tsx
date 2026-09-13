import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { AccountingBoard } from "./AccountingBoard";

export default async function AccountingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/accounting");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without MANAGE_ACCOUNTING shouldn't reach this page at all — the
  // sidebar already hides the nav link (DashboardShell); this redirect is
  // what actually enforces it against a direct URL hit, same pattern as
  // account-books/page.tsx.
  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_ACCOUNTING)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Accounting</h1>
        <p className="text-sm text-neutral-500">
          Double-entry books for {active.name} — Chart of Accounts, journal vouchers, and financial
          balances. Separate from Account Books, which stays available for day-to-day cash tracking.
        </p>
      </div>
      <AccountingBoard
        slug={active.slug}
        canReopenPeriod={roleHasPermission(active.role, PERMISSIONS.REOPEN_ACCOUNTING_PERIOD)}
      />
    </div>
  );
}
