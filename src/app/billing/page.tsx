import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { BillingBoard } from "./BillingBoard";
import { LogoutButton } from "./LogoutButton";

/**
 * A deliberately top-level route (NOT under /dashboard) — the dashboard
 * layout redirects a restaurant with an inactive subscription here, and
 * this page has to be reachable regardless of that same subscription
 * state, or the redirect would loop into itself. See
 * src/app/dashboard/layout.tsx's comment for the full reasoning.
 *
 * Any signed-in staff member can view this page (so everyone understands
 * *why* they were redirected here, not just the owner) — only
 * MANAGE_SUBSCRIPTION holders (owner/platform_admin) see the actual
 * "request a plan" actions, gated by `canManageSubscription` from the
 * billing API response and rendered inside BillingBoard.
 */
export default async function BillingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/billing");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div className="min-h-screen bg-surface-1">
      <header className="flex items-center justify-between border-b border-hairline bg-surface-2 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-semibold tracking-tight text-ink">
              Restro<span className="text-orange-400">Kendra</span>
            </span>
            <span className="text-[10px] font-medium text-ink-faint">by Saugat Thapa</span>
          </span>
          <span className="hidden text-sm text-ink-faint sm:inline">/ Billing</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-ink-muted">{active.name}</span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl p-4 md:p-8">
        <BillingBoard slug={active.slug} />
      </main>
    </div>
  );
}
