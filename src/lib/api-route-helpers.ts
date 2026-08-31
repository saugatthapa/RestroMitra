import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import * as Sentry from "@sentry/nextjs";
import {
  requireAuth,
  requirePermission,
  requireRestaurantBySlug,
  requireActiveSubscription,
  requireRestaurantActive,
  requireNotInMaintenanceMode,
  isPlatformOrImpersonatedRole,
} from "@/lib/rbac/guard";
import { HttpError } from "@/lib/http-error";
import type { PermissionKey } from "@/lib/rbac/permissions";
import type { SessionContext } from "@/lib/auth/session";
import { requireFeature } from "@/lib/entitlements-db";
import type { FeatureKey } from "@/lib/feature-catalog";

/**
 * Converts a thrown HttpError (AuthError, OrderValidationError, ...) — or
 * anything else — into a JSON response. Anything that isn't a recognized
 * HttpError is logged server-side and returned as an opaque 500, so we
 * never leak internal error details (stack traces, DB error text) to a
 * client, authenticated or not.
 *
 * RC audit P1 fix — this is the shared error handler ~76 API routes funnel
 * through via `catch (err) { return toErrorResponse(err); }`, which is
 * exactly why the dominant class of "API failure" never reached Sentry
 * even with a DSN configured: this catch-everything pattern means the
 * error never escapes uncaught, so instrumentation.ts's own
 * `onRequestError` hook (Sentry.captureRequestError) never fires either.
 * The unhandled-error branch below now reports to Sentry directly.
 * HttpErrors are deliberately NOT reported — those are expected,
 * recognized failures (a 404, a validation 400, a permission 403), not
 * bugs; reporting every one would bury the genuinely unexpected 500s this
 * exists to surface. Same no-op-until-SENTRY_DSN-is-set behavior as every
 * other Sentry call site in this app (see sentry.server.config.ts's own
 * comment) — safe to call unconditionally.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("Unhandled API error:", err);
  Sentry.captureException(err);
  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

export type RestaurantContext = {
  session: SessionContext;
  restaurantId: string;
  role: string;
  branchId: string | null;
  /** For "what day is it for this restaurant" computations — see
   * src/lib/restaurant-date.ts. Never UTC's calendar day. */
  timezone: string;
};

/**
 * The standard entry point for any restaurant-scoped API route: resolves
 * the authenticated user, resolves the restaurant from its slug (trusted,
 * server-side lookup — never a client-supplied id), confirms this user has
 * an active role grant on it, confirms the restaurant's subscription is
 * currently active (Phase 10 — skippable via
 * `opts.allowInactiveSubscription`, which the billing routes themselves
 * need so a blocked owner can still view their status and request an
 * upgrade), and — if a permission is given — confirms that specific
 * permission. Throws AuthError/SubscriptionRequiredError on any failure;
 * callers should catch via toErrorResponse().
 *
 * platform_admin always bypasses the subscription check regardless of
 * `opts` — support/ops access to a tenant must never depend on that
 * tenant's own billing state. platform_admin also bypasses the newer
 * suspension check below (Phase 2) — support/ops must still be able to
 * reach a suspended tenant to investigate it — but that one has no
 * `opts` escape hatch for anyone else: unlike a billing lapse, suspension
 * is never something a tenant-scoped route should be allowed to work
 * around.
 *
 * `opts.requireFeature` (Phase 17 — plan-gated attendance tiers) is the
 * single place a route opts into the Phase 5 entitlement engine, the same
 * way `permission` is the single place it opts into RBAC — pass a
 * FEATURES key and this throws FeatureNotEntitledError (a plain 403) when
 * the restaurant's current plan/override/flag combination doesn't grant
 * it. Checked AFTER the permission check (a route that needs both a
 * permission AND a feature should fail on the permission first — "you
 * can't do this at all" is a more useful error than "your plan doesn't
 * include this" for someone who was never allowed to try in the first
 * place) and, like suspension/maintenance-mode above, skipped entirely
 * for platform_admin/impersonated roles — support/ops investigating a
 * tenant must see the same capabilities regardless of that tenant's plan.
 */
export async function resolveRestaurantContext(
  slug: string,
  permission?: PermissionKey,
  opts?: { allowInactiveSubscription?: boolean; requireFeature?: FeatureKey },
): Promise<RestaurantContext> {
  const session = await requireAuth();
  const { restaurantId, role, branchId, timezone } = await requireRestaurantBySlug(
    session.user.id,
    slug,
  );
  // Phase 8 — an active impersonation session bypasses these two the same
  // way platform_admin's blanket cross-tenant access always has (see
  // isPlatformOrImpersonatedRole's own comment): investigating a
  // suspended or billing-lapsed tenant is exactly the kind of support/ops
  // task impersonation exists for.
  if (!isPlatformOrImpersonatedRole(role)) {
    await requireRestaurantActive(restaurantId);
  }
  if (!isPlatformOrImpersonatedRole(role) && !opts?.allowInactiveSubscription) {
    await requireActiveSubscription(restaurantId);
  }
  // Phase 10 — platform-wide maintenance mode blocks every tenant-scoped
  // route the same way suspension does, with the same platform-admin/
  // impersonation exemption (see requireNotInMaintenanceMode's own
  // comment for why that exemption is this phase's break-glass access).
  await requireNotInMaintenanceMode(role);
  if (permission) {
    // Perf: `role` was already resolved by requireRestaurantBySlug above
    // (which itself calls requireRestaurantAccess) — passing it through
    // skips requirePermission re-deriving the identical answer via a
    // second isPlatformAdmin + userRoles round trip. See guard.ts's
    // requirePermission doc comment and PERFORMANCE_AUDIT.md.
    await requirePermission(session.user.id, restaurantId, permission, role);
  }
  if (opts?.requireFeature && !isPlatformOrImpersonatedRole(role)) {
    await requireFeature(restaurantId, opts.requireFeature);
  }
  return { session, restaurantId, role, branchId, timezone };
}

/** Parses and validates a JSON request body, or returns a 400 response. */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input." },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}
