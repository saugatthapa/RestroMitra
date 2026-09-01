import "server-only";
import { and, desc, eq, gte, isNull, lt, like } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, branches, restaurants, users } from "@/db/schema";
import { getImpersonationContext } from "@/lib/auth/impersonation";
import { getMaintenanceMode } from "@/lib/system/maintenance-mode-db";

export async function recordAuditLog(entry: {
  restaurantId?: string | null;
  userId?: string | null;
  /**
   * RC audit P1 fix (restaurant-facing audit log UI gap) — optional and
   * populated only at the call sites that already resolve a branchId for
   * the action being logged (orders, tables, reservations, purchases).
   * Most of this project's 150+ recordAuditLog() call sites genuinely
   * aren't branch-scoped (auth, settings, staff role/salary, subscription,
   * platform-level actions) and are correctly left `null` here — see the
   * audit_logs.branchId column comment in schema.ts.
   */
  branchId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  let metadata = entry.metadata;

  // Phase 8 (Platform Control Center) — Impersonation. Centralized here
  // rather than touching any of this project's 150+ existing
  // recordAuditLog() call sites: every one of them already passes
  // `userId: session.user.id` (the REAL, authenticated admin —
  // impersonation never invents a "logged in as the tenant" identity, see
  // impersonation.ts's own header comment), so all that's missing is a
  // flag saying "and this action was actually performed against a
  // restaurant they don't have a real role at, under an active
  // impersonation grant." Only applied when this entry's restaurantId
  // actually matches the currently-active impersonation's target — an
  // admin's own platform-level actions (restaurantId omitted) or actions
  // against a DIFFERENT restaurant reached through the untouched
  // isPlatformAdmin bypass are never mistagged as impersonated. Never
  // overwrites the caller's own metadata keys other than these three, so
  // this never silently changes the meaning of any existing audit entry
  // for a non-impersonated action (getImpersonationContext() returns null
  // whenever there's no active session, which is every call site today).
  if (entry.restaurantId) {
    const impersonation = await getImpersonationContext();
    if (impersonation && impersonation.targetRestaurantId === entry.restaurantId) {
      metadata = {
        ...metadata,
        isImpersonated: true,
        impersonationSessionId: impersonation.impersonationSessionId,
        impersonationReason: impersonation.reason,
      };
    }
  }

  // Platform Control Center (Phase 10) — break-glass traceability. While
  // maintenance mode is on, only a platform admin/impersonation session
  // can act at all (see guard.ts's requireNotInMaintenanceMode) — so ANY
  // audit entry recorded during that window represents an action taken
  // under that emergency-access exemption, worth flagging without relying
  // on a human to remember which incidents happened during which outage.
  // Unlike the impersonation tag above, this isn't scoped to one
  // restaurant — maintenance mode is a platform-wide state, so every
  // entry (tenant-scoped or platform-level) gets it.
  const maintenanceMode = await getMaintenanceMode();
  if (maintenanceMode.enabled) {
    metadata = { ...metadata, duringMaintenanceMode: true };
  }

  await db.insert(auditLogs).values({
    restaurantId: entry.restaurantId ?? null,
    userId: entry.userId ?? null,
    branchId: entry.branchId ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ipAddress: entry.ipAddress ?? null,
    metadata,
  });
}

export type AuditLogListOptions = {
  limit?: number;
  offset?: number;
  /** Matches actions starting with this prefix, e.g. "payment." for every payment/refund event. */
  actionPrefix?: string;
  resourceType?: string;
  /** Narrows to one actor. */
  userId?: string;
  /**
   * Narrows to one branch. Only matches entries that were actually tagged
   * with a branchId at write time (see recordAuditLog's own comment on its
   * `branchId` param) — restaurant-wide entries (branchId: null) are never
   * matched, even when a specific branch is requested, since there's no
   * branch to attribute them to.
   */
  branchId?: string;
  /** Restaurant-local calendar-day bounds, half-open [from, dayAfterTo) — pass already-resolved Date instants (see restaurant-date.ts), not raw strings, so this module stays timezone-agnostic. */
  createdFrom?: Date;
  createdBefore?: Date;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * RC audit P1 fix — recordAuditLog() above has been writing to audit_logs
 * since Phase 2 (55+ call sites), but there was never a read path for any
 * of it. Extracted as its own pure, testable function (same pattern as
 * reports.ts's getSalesSummary/getCogsSummary) rather than living inline
 * in the route, per this project's own convention for anything worth a DB
 * integration test — see audit-log-list.test.ts.
 *
 * Newest first. Fetches one extra row beyond `limit` to report `hasMore`
 * without a separate COUNT(*) query — the log can grow large and
 * unbounded, so an exact total isn't worth a second full-table scan on
 * every page.
 */
export async function listAuditLogs(restaurantId: string, opts: AuditLogListOptions = {}) {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [eq(auditLogs.restaurantId, restaurantId)];
  if (opts.actionPrefix) conditions.push(like(auditLogs.action, `${opts.actionPrefix}%`));
  if (opts.resourceType) conditions.push(eq(auditLogs.resourceType, opts.resourceType));
  if (opts.userId) conditions.push(eq(auditLogs.userId, opts.userId));
  if (opts.branchId) conditions.push(eq(auditLogs.branchId, opts.branchId));
  if (opts.createdFrom) conditions.push(gte(auditLogs.createdAt, opts.createdFrom));
  if (opts.createdBefore) conditions.push(lt(auditLogs.createdAt, opts.createdBefore));

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      ipAddress: auditLogs.ipAddress,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      userId: auditLogs.userId,
      userFullName: users.fullName,
      branchId: auditLogs.branchId,
      branchName: branches.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(branches, eq(auditLogs.branchId, branches.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  return { logs: hasMore ? rows.slice(0, limit) : rows, hasMore, limit, offset };
}

export type PlatformAuditLogListOptions = Omit<AuditLogListOptions, "createdFrom" | "createdBefore"> & {
  /**
   * Narrows to one restaurant's events (a platform admin drilling into a
   * single tenant's history), or explicitly `null` for platform-only
   * events (restaurantId IS NULL — role grants, plan/flag edits, and every
   * other action with no single tenant). Omit entirely for the default
   * platform audit log view: every event, across every tenant AND the
   * platform itself.
   */
  restaurantId?: string | null;
  /** UTC calendar-day bounds (YYYY-MM-DD), inclusive `from`/exclusive `to`. Unlike listAuditLogs' restaurant-local createdFrom/createdBefore, there's no single tenant timezone to resolve against here — see the route's own comment. */
  createdFrom?: Date;
  createdBefore?: Date;
};

/**
 * Platform Control Center (Phase 6) — the platform-wide counterpart to
 * listAuditLogs(): no restaurantId is required, since a platform admin's
 * audit view spans every tenant (and the platform's own restaurantId:
 * null events — role grants, plan edits, feature flag changes) rather
 * than being scoped to one. Kept as a separate function rather than making
 * listAuditLogs' restaurantId parameter optional, so the tenant-scoped
 * route (which must never accidentally see another tenant's log) can't be
 * called without one.
 */
export async function listPlatformAuditLogs(opts: PlatformAuditLogListOptions = {}) {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [];
  if (opts.restaurantId === null) {
    conditions.push(isNull(auditLogs.restaurantId));
  } else if (opts.restaurantId) {
    conditions.push(eq(auditLogs.restaurantId, opts.restaurantId));
  }
  if (opts.actionPrefix) conditions.push(like(auditLogs.action, `${opts.actionPrefix}%`));
  if (opts.resourceType) conditions.push(eq(auditLogs.resourceType, opts.resourceType));
  if (opts.userId) conditions.push(eq(auditLogs.userId, opts.userId));
  if (opts.branchId) conditions.push(eq(auditLogs.branchId, opts.branchId));
  if (opts.createdFrom) conditions.push(gte(auditLogs.createdAt, opts.createdFrom));
  if (opts.createdBefore) conditions.push(lt(auditLogs.createdAt, opts.createdBefore));

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      ipAddress: auditLogs.ipAddress,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      userId: auditLogs.userId,
      userFullName: users.fullName,
      restaurantId: auditLogs.restaurantId,
      restaurantName: restaurants.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(restaurants, eq(auditLogs.restaurantId, restaurants.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  return { logs: hasMore ? rows.slice(0, limit) : rows, hasMore, limit, offset };
}
