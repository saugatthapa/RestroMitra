import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants, getSelectableBranches } from "@/lib/restaurant";
import { computeSubscriptionAccess } from "@/lib/subscription";
import { DashboardShell } from "./DashboardShell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  // Which restaurant is "active" lives on the session row
  // (session.activeRestaurantId), not a cookie — the header's restaurant
  // switcher (DashboardShell, for users with more than one restaurant)
  // calls POST /api/session/active-restaurant to change it, then triggers
  // a router.refresh() so this layout re-resolves `active` on the next
  // request.
  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ??
    restaurants[0];

  // Phase 2 (Platform Control Center) — a restaurant a platform admin has
  // suspended (see guard.ts's requireRestaurantActive) is blocked from
  // /dashboard entirely, except for platform_admin (support/ops must
  // still be able to reach it). Checked BEFORE the subscription check
  // below, and matching the API layer's resolveRestaurantContext ordering
  // exactly: suspension is the more deliberate, ops-driven block, so a
  // restaurant that happens to be both suspended and billing-inactive
  // lands on /suspended, not /billing — and critically, this keeps the
  // two conditions from ever fighting over which redirect wins.
  if (active.role !== "platform_admin" && !active.isActive) {
    redirect("/suspended");
  }

  // Phase 10: every /dashboard/* page is gated on the restaurant's
  // subscription being currently active — except for platform_admin, who
  // must always be able to reach a tenant's dashboard for support/ops
  // regardless of that tenant's own billing state (same bypass as the API
  // layer's requireActiveSubscription). This is a read-only check (see
  // computeSubscriptionAccess's own comment on why): the actual DB
  // self-healing write for a just-expired trial happens lazily the next
  // time this restaurant's data is fetched through the API, not here.
  // /billing itself is a top-level route (not under /dashboard), so this
  // redirect can never loop back into itself.
  if (active.role !== "platform_admin") {
    const access = computeSubscriptionAccess({
      subscriptionStatus: active.subscriptionStatus,
      trialEndsAt: active.trialEndsAt,
    });
    if (!access.allowed) redirect("/billing");
  }

  // Header branch switcher (Reports filtering) — platform_admin has no
  // userRoles row on a tenant it's viewing for support/ops (see
  // requireRestaurantAccess's bypass), so it never gets a branch lock and
  // this simply returns every active branch for them, same as an
  // unrestricted owner/manager would see.
  const selectableBranches = await getSelectableBranches(session.user.id, active.id);

  return (
    <DashboardShell
      ownerName={session.user.fullName}
      restaurantName={active.name}
      role={active.role}
      subscriptionStatus={active.subscriptionStatus}
      trialEndsAt={active.trialEndsAt ? active.trialEndsAt.toISOString() : null}
      slug={active.slug}
      logoUrl={active.logoUrl}
      restaurants={restaurants.map((r) => ({ id: r.id, name: r.name }))}
      activeRestaurantId={active.id}
      branches={selectableBranches}
    >
      {children}
    </DashboardShell>
  );
}
