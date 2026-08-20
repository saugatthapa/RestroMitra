import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import {
  requireAuth,
  requirePermission,
  requireRestaurantBySlug,
  requireActiveSubscription,
} from "@/lib/rbac/guard";
import { HttpError } from "@/lib/http-error";
import type { PermissionKey } from "@/lib/rbac/permissions";
import type { SessionContext } from "@/lib/auth/session";

/**
 * Converts a thrown HttpError (AuthError, OrderValidationError, ...) — or
 * anything else — into a JSON response. Anything that isn't a recognized
 * HttpError is logged server-side and returned as an opaque 500, so we
 * never leak internal error details (stack traces, DB error text) to a
 * client, authenticated or not.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("Unhandled API error:", err);
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
 * tenant's own billing state.
 */
export async function resolveRestaurantContext(
  slug: string,
  permission?: PermissionKey,
  opts?: { allowInactiveSubscription?: boolean },
): Promise<RestaurantContext> {
  const session = await requireAuth();
  const { restaurantId, role, branchId } = await requireRestaurantBySlug(
    session.user.id,
    slug,
  );
  if (role !== "platform_admin" && !opts?.allowInactiveSubscription) {
    await requireActiveSubscription(restaurantId);
  }
  if (permission) {
    // Perf: `role` was already resolved by requireRestaurantBySlug above
    // (which itself calls requireRestaurantAccess) — passing it through
    // skips requirePermission re-deriving the identical answer via a
    // second isPlatformAdmin + userRoles round trip. See guard.ts's
    // requirePermission doc comment and PERFORMANCE_AUDIT.md.
    await requirePermission(session.user.id, restaurantId, permission, role);
  }
  return { session, restaurantId, role, branchId };
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
