import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { LogoutButton } from "@/app/billing/LogoutButton";

/**
 * Platform Control Center (Phase 2) — a deliberately top-level route (NOT
 * under /dashboard), same reasoning as /billing: the dashboard layout
 * redirects a suspended restaurant's staff here, so this page has to be
 * reachable regardless of that same suspended state or the redirect would
 * loop into itself. See src/app/dashboard/layout.tsx's comment.
 *
 * No self-service action here, unlike /billing — reactivating a suspended
 * restaurant is a platform-admin-only decision (see the admin restaurant
 * detail page), never something the owner can do themselves. This page
 * exists purely so staff understand why they were locked out, not to
 * offer a way around it.
 */
export default async function SuspendedPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/suspended");

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
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-ink-muted">{active.name}</span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-lg p-4 py-16 text-center md:p-8">
        <div className="rounded-xl border border-red-500/30 bg-red-500/15 p-6">
          <h1 className="text-lg font-semibold text-red-300">Access suspended</h1>
          <p className="mt-2 text-sm text-red-300">
            {active.name}&apos;s access to RestroKendra has been suspended by the platform. Your
            data is preserved and nothing has been deleted — this can be reversed.
          </p>
          <p className="mt-3 text-sm text-red-300">
            Contact RestroKendra support for details or to request reinstatement.
          </p>
        </div>
      </main>
    </div>
  );
}
