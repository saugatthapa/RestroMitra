import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import {
  getUserRestaurants,
  getSelectableBranches,
  getRestaurantForImpersonation,
  type OwnedRestaurant,
} from "@/lib/restaurant";
import { getImpersonationContext } from "@/lib/auth/impersonation";
import { isPlatformOrImpersonatedRole } from "@/lib/rbac/guard";
import { computeSubscriptionAccess } from "@/lib/subscription";
import { getMaintenanceMode } from "@/lib/system/maintenance-mode-db";
import { getActiveAnnouncements } from "@/lib/system/announcements-db";
import { DashboardShell } from "./DashboardShell";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { AnnouncementBanner } from "./AnnouncementBanner";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard");

  // Phase 8 (Platform Control Center) — impersonation is a wholly separate
  // grant layered on top of this session (see impersonation.ts's own
  // header comment); the admin's own login above is never touched by it.
  // Before impersonation existed, a platform admin with no real
  // `userRoles` grant anywhere had NO path into /dashboard at all — the
  // list below is purely user_roles-driven. Impersonation is what actually
  // gives them dashboard reachability for a specific target restaurant, so
  // it's resolved here, first, and only trusted when it belongs to THIS
  // signed-in user (never taken from any client-supplied id).
  const impersonation = await getImpersonationContext();
  const isImpersonating = Boolean(
    impersonation && impersonation.adminUserId === session.user.id,
  );

  let restaurants: OwnedRestaurant[];
  let active: OwnedRestaurant;

  if (isImpersonating && impersonation) {
    const target = await getRestaurantForImpersonation(impersonation.targetRestaurantId);
    if (!target) {
      // Should be unreachable (ON DELETE CASCADE on the impersonation
      // session's target_restaurant_id FK — see getRestaurantForImpersonation's
      // own comment), but fail safe rather than crash the layout.
      redirect("/admin/restaurants");
    }
    active = {
      ...target,
      role: impersonation.mode === "write" ? "impersonated_write" : "impersonated_read",
    };
    // The header switcher only renders when it has more than one entry
    // (see DashboardShell) — a single-entry list naturally hides it, so an
    // impersonating admin never sees a UI path to silently hop to a
    // different restaurant.
    restaurants = [active];
  } else {
    restaurants = await getUserRestaurants(session.user.id);
    if (restaurants.length === 0) redirect("/onboarding");

    // Which restaurant is "active" lives on the session row
    // (session.activeRestaurantId), not a cookie — the header's restaurant
    // switcher (DashboardShell, for users with more than one restaurant)
    // calls POST /api/session/active-restaurant to change it, then triggers
    // a router.refresh() so this layout re-resolves `active` on the next
    // request.
    active =
      restaurants.find((r) => r.id === session.activeRestaurantId) ??
      restaurants[0];
  }

  // Phase 2 (Platform Control Center) — a restaurant a platform admin has
  // suspended (see guard.ts's requireRestaurantActive) is blocked from
  // /dashboard entirely, except for platform_admin and an active
  // impersonation session (Phase 8) — support/ops must still be able to
  // reach it. Checked BEFORE the subscription check below, and matching
  // the API layer's resolveRestaurantContext ordering exactly: suspension
  // is the more deliberate, ops-driven block, so a restaurant that happens
  // to be both suspended and billing-inactive lands on /suspended, not
  // /billing — and critically, this keeps the two conditions from ever
  // fighting over which redirect wins.
  if (!isPlatformOrImpersonatedRole(active.role) && !active.isActive) {
    redirect("/suspended");
  }

  // Phase 10: every /dashboard/* page is gated on the restaurant's
  // subscription being currently active — except for platform_admin and an
  // active impersonation session, who must always be able to reach a
  // tenant's dashboard for support/ops regardless of that tenant's own
  // billing state (same bypass as the API layer's requireActiveSubscription).
  // This is a read-only check (see computeSubscriptionAccess's own comment
  // on why): the actual DB self-healing write for a just-expired trial
  // happens lazily the next time this restaurant's data is fetched through
  // the API, not here. /billing itself is a top-level route (not under
  // /dashboard), so this redirect can never loop back into itself.
  if (!isPlatformOrImpersonatedRole(active.role)) {
    const access = computeSubscriptionAccess({
      subscriptionStatus: active.subscriptionStatus,
      trialEndsAt: active.trialEndsAt,
    });
    if (!access.allowed) redirect("/billing");
  }

  // Platform Control Center (Phase 10) — platform-wide maintenance mode
  // blocks every /dashboard/* page the same way suspension does, with the
  // same platform-admin/impersonation exemption. See
  // guard.ts's requireNotInMaintenanceMode (the API-layer equivalent) for
  // why that exemption is this phase's break-glass access, and
  // /maintenance for the page this redirects to.
  if (!isPlatformOrImpersonatedRole(active.role)) {
    const maintenanceMode = await getMaintenanceMode();
    if (maintenanceMode.enabled) redirect("/maintenance");
  }

  // Header branch switcher (Reports filtering) — platform_admin and an
  // impersonating admin both have no userRoles row on a tenant they're
  // viewing for support/ops (see requireRestaurantAccess's bypass), so
  // neither ever gets a branch lock and this simply returns every active
  // branch for them, same as an unrestricted owner/manager would see.
  const [selectableBranches, announcements] = await Promise.all([
    getSelectableBranches(session.user.id, active.id),
    getActiveAnnouncements(),
  ]);

  return (
    <>
      {isImpersonating && impersonation && (
        <ImpersonationBanner
          restaurantName={active.name}
          reason={impersonation.reason}
          mode={impersonation.mode}
          startedAt={impersonation.startedAt.toISOString()}
          expiresAt={impersonation.expiresAt.toISOString()}
        />
      )}
      {announcements.length > 0 && (
        <AnnouncementBanner
          announcements={announcements.map((a) => ({
            id: a.id,
            title: a.title,
            body: a.body,
            severity: a.severity,
          }))}
        />
      )}
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
    </>
  );
}
