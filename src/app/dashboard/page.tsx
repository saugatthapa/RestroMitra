import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants, getRestaurantForImpersonation, type OwnedRestaurant } from "@/lib/restaurant";
import { getImpersonationContext } from "@/lib/auth/impersonation";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { DashboardStats } from "./DashboardStats";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard");

  // Platform Control Center (Phase 8) — mirrors dashboard/layout.tsx's own
  // impersonation-aware resolution exactly (see that file's comment for the
  // full rationale). Without this, an impersonating platform admin — who
  // deliberately holds no real userRoles grant on the target restaurant —
  // always gets `restaurants.length === 0` from a plain getUserRestaurants()
  // call and is bounced to /onboarding the instant they land here, even
  // though the layout wrapping this page already resolved and rendered the
  // impersonation banner around it. Discovered via the platform-admin E2E
  // spec (e2e/platform-admin.spec.ts): the banner would flash into
  // existence for a frame and then the whole page would redirect away,
  // because THIS page — not the layout — is what /dashboard actually
  // renders, and it was still doing the pre-impersonation, owner-only
  // lookup on its own. Duplicating this resolution here (rather than only
  // in the layout) matches this codebase's own established convention —
  // see getUserRestaurants' own doc comment on why dashboard/layout.tsx and
  // dashboard/page.tsx already independently call it, deduped per-request
  // by React's cache().
  const impersonation = await getImpersonationContext();
  const isImpersonating = Boolean(
    impersonation && impersonation.adminUserId === session.user.id,
  );

  let restaurants: OwnedRestaurant[];
  let active: OwnedRestaurant;

  if (isImpersonating && impersonation) {
    const target = await getRestaurantForImpersonation(impersonation.targetRestaurantId);
    if (!target) redirect("/admin/restaurants");
    active = {
      ...target,
      role: impersonation.mode === "write" ? "impersonated_write" : "impersonated_read",
    };
    restaurants = [active];
  } else {
    restaurants = await getUserRestaurants(session.user.id);
    if (restaurants.length === 0) redirect("/onboarding");
    active = restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  }

  // Only used for the intro paragraph's wording below — the actual
  // permission-gated data fetching for the stat tiles/monthly block now
  // happens client-side in DashboardStats (see that file's comment for
  // why: it needs to react to the header's branch switcher, which a
  // server component can't see).
  const canViewReports = roleHasPermission(active.role, PERMISSIONS.VIEW_REPORTS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">
          Welcome back, {session.user.fullName.split(" ")[0]}
        </h1>
        <p className="text-sm text-ink-muted">
          Orders placed by customers show up on the{" "}
          <span className="font-medium text-ink-secondary">Orders</span> board in real time
          (polling every few seconds) — move them through confirmed → preparing → ready →
          served → completed from there.
          {canViewReports && (
            <>
              {" "}
              Head to <span className="font-medium text-ink-secondary">Reports</span> for revenue
              trends, top items, and peak-hour analytics.
            </>
          )}
        </p>
      </div>

      <DashboardStats slug={active.slug} />
    </div>
  );
}
