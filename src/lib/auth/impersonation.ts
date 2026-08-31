import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { platformImpersonationSessions, restaurants } from "@/db/schema";
import { generateToken, hashToken } from "./session";
import { IMPERSONATION_SESSION_COOKIE_NAME } from "./impersonation-cookie";

/**
 * Platform Control Center (Phase 8) — Impersonation.
 *
 * Deliberately a SEPARATE session mechanism from src/lib/auth/session.ts,
 * not an extension of it — starting or ending impersonation never reads,
 * writes, or otherwise touches the acting admin's own `sessions` row or
 * its cookie. Concretely: an admin who starts impersonating restaurant X
 * in one tab can open /admin in a second tab and it works exactly as
 * before — same login, same session, nothing about their platform access
 * changed. This is what makes "one-click exit" safe: ending impersonation
 * only ever needs to clear/invalidate THIS mechanism's own state, never
 * risking the admin's own login in the process.
 *
 * The two mechanisms layer, they don't merge: the admin's identity for
 * every purpose (who's logged in, what they can do at the platform level,
 * whose name shows up as the actor in every audit log entry) still comes
 * from getSession()/the main session cookie, exactly as it always has —
 * this module never invents a "logged in as the tenant" identity. What
 * this module adds is a scoped, time-boxed, reasoned CAPABILITY GRANT:
 * "the currently-authenticated admin may additionally act as restaurant X
 * (read-only, or read/write) until this expires." See
 * src/lib/rbac/guard.ts's requireRestaurantAccess() for where that grant
 * actually gets consulted, and src/lib/audit.ts's recordAuditLog() for
 * where every resulting action gets tagged.
 */

const IMPERSONATION_SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export type ImpersonationMode = "read_only" | "write";

export type ImpersonationContext = {
  impersonationSessionId: string;
  adminUserId: string;
  targetRestaurantId: string;
  targetRestaurantName: string;
  targetRestaurantSlug: string;
  reason: string;
  mode: ImpersonationMode;
  startedAt: Date;
  expiresAt: Date;
};

export class ImpersonationAlreadyActiveError extends Error {
  constructor() {
    super(
      "You already have an active impersonation session. Exit it before starting a new one.",
    );
    this.name = "ImpersonationAlreadyActiveError";
  }
}

/**
 * Starts a new impersonation grant and sets its cookie. Throws
 * ImpersonationAlreadyActiveError if this admin already has one running
 * (item 17/32 of the spec this phase followed — "no nested impersonation,"
 * enforced primarily by the database's own partial unique index
 * (platform_impersonation_sessions_one_active_per_admin_unique), not just
 * this pre-check — a concurrent double-submit still can't create two
 * active rows even if both requests race past the check below at the same
 * instant).
 *
 * Caller is responsible for permission checks (IMPERSONATE_TENANT /
 * IMPERSONATE_TENANT_WRITE — see the API route) — this function only
 * enforces the data-level invariants (target restaurant exists, no
 * existing active grant, a real reason).
 */
export async function startImpersonation(params: {
  adminUserId: string;
  targetRestaurantId: string;
  reason: string;
  mode: ImpersonationMode;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<ImpersonationContext> {
  const reason = params.reason.trim();
  if (!reason) {
    throw new Error("A reason is required to start impersonation.");
  }

  const [target] = await db
    .select({ id: restaurants.id, name: restaurants.name, slug: restaurants.slug })
    .from(restaurants)
    .where(eq(restaurants.id, params.targetRestaurantId))
    .limit(1);
  if (!target) {
    throw new Error("Restaurant not found.");
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + IMPERSONATION_SESSION_DURATION_MS);

  let sessionId: string;
  try {
    const [row] = await db
      .insert(platformImpersonationSessions)
      .values({
        tokenHash,
        adminUserId: params.adminUserId,
        targetRestaurantId: params.targetRestaurantId,
        reason,
        mode: params.mode,
        status: "active",
        startedAt,
        expiresAt,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      })
      .returning({ id: platformImpersonationSessions.id });
    sessionId = row.id;
  } catch (err) {
    // The partial unique index (one active row per adminUserId) is the
    // actual concurrency guarantee; a unique-violation here means another
    // request for this same admin won the race (or the pre-existing
    // active-session check elsewhere raced this one) — either way, the
    // correct answer is the same friendly error, not a raw DB constraint
    // message.
    if (err instanceof Error && /unique/i.test(err.message)) {
      throw new ImpersonationAlreadyActiveError();
    }
    throw err;
  }

  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATION_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  return {
    impersonationSessionId: sessionId,
    adminUserId: params.adminUserId,
    targetRestaurantId: target.id,
    targetRestaurantName: target.name,
    targetRestaurantSlug: target.slug,
    reason,
    mode: params.mode,
    startedAt,
    expiresAt,
  };
}

async function getImpersonationContextUncached(): Promise<ImpersonationContext | null> {
  let cookieStore: Awaited<ReturnType<typeof cookies>>;
  try {
    cookieStore = await cookies();
  } catch {
    // Called outside an active Next.js request scope (no requestAsyncStorage
    // — e.g. a background/cron job, or this module being exercised outside
    // a route handler/server component, including this project's own DB
    // integration test suite, which runs under plain Node with no Next.js
    // request context at all). There is no cookie to read either way, which
    // is equivalent to "no impersonation active" — this must never throw,
    // since audit.ts's recordAuditLog() now calls this unconditionally on
    // every tenant-scoped audit entry, across ~150 existing call sites that
    // have nothing to do with impersonation.
    return null;
  }
  const token = cookieStore.get(IMPERSONATION_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      id: platformImpersonationSessions.id,
      adminUserId: platformImpersonationSessions.adminUserId,
      targetRestaurantId: platformImpersonationSessions.targetRestaurantId,
      targetRestaurantName: restaurants.name,
      targetRestaurantSlug: restaurants.slug,
      reason: platformImpersonationSessions.reason,
      mode: platformImpersonationSessions.mode,
      status: platformImpersonationSessions.status,
      startedAt: platformImpersonationSessions.startedAt,
      expiresAt: platformImpersonationSessions.expiresAt,
    })
    .from(platformImpersonationSessions)
    .innerJoin(restaurants, eq(platformImpersonationSessions.targetRestaurantId, restaurants.id))
    .where(eq(platformImpersonationSessions.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  if (row.status !== "active") return null;

  // Server-side expiry check on every single call — the cookie's own
  // `expires` attribute is a courtesy for the browser, never trusted on
  // its own (spec item 16). A session found past its expiresAt is lazily
  // flipped to "expired" here (same "expire on next read" pattern
  // session.ts's getSession uses for destroySession) rather than relying
  // on a background sweep.
  if (row.expiresAt.getTime() < Date.now()) {
    await db
      .update(platformImpersonationSessions)
      .set({ status: "expired", endedAt: new Date() })
      .where(eq(platformImpersonationSessions.id, row.id));
    cookieStore.delete(IMPERSONATION_SESSION_COOKIE_NAME);
    return null;
  }

  return {
    impersonationSessionId: row.id,
    adminUserId: row.adminUserId,
    targetRestaurantId: row.targetRestaurantId,
    targetRestaurantName: row.targetRestaurantName,
    targetRestaurantSlug: row.targetRestaurantSlug,
    reason: row.reason,
    mode: row.mode,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
  };
}

/** React-cache()'d per request, same rationale/safety as getSession() in session.ts — see that function's own comment. */
export const getImpersonationContext = cache(getImpersonationContextUncached);

/**
 * Ends the CURRENT browser's impersonation session (the normal "Exit
 * impersonation" button) — resolved from the impersonation cookie itself,
 * not a passed-in id, so this can never be used to end someone else's
 * session (see revokeImpersonationSession for that, which deliberately
 * takes an explicit id and a separate permission check). Clears the
 * cookie regardless of whether a matching row was found, so a stale/
 * already-expired cookie is always cleaned up client-side.
 */
export async function exitImpersonation(endedByUserId: string): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(IMPERSONATION_SESSION_COOKIE_NAME)?.value;
  if (token) {
    const tokenHash = hashToken(token);
    await db
      .update(platformImpersonationSessions)
      .set({ status: "ended", endedAt: new Date(), endedByUserId })
      .where(and(eq(platformImpersonationSessions.tokenHash, tokenHash), eq(platformImpersonationSessions.status, "active")));
  }
  cookieStore.delete(IMPERSONATION_SESSION_COOKIE_NAME);
}

/**
 * Force-ends ANOTHER admin's active impersonation session (the platform
 * dashboard's "Revoke" action — spec item 25) — takes an explicit
 * sessionId rather than reading any cookie, since the revoking admin's
 * own browser was never the one holding this grant. This only flips the
 * row's status server-side; the impersonating admin's own browser still
 * holds the now-invalid cookie until its next request, at which point
 * getImpersonationContext's status check above denies it (never re-reads
 * as active).
 */
export async function revokeImpersonationSession(
  sessionId: string,
  revokedByUserId: string,
): Promise<boolean> {
  const [row] = await db
    .update(platformImpersonationSessions)
    .set({ status: "revoked", endedAt: new Date(), endedByUserId: revokedByUserId })
    .where(and(eq(platformImpersonationSessions.id, sessionId), eq(platformImpersonationSessions.status, "active")))
    .returning({ id: platformImpersonationSessions.id });
  return Boolean(row);
}
