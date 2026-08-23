import "server-only";
import { and, desc, eq, gte, lt, like } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";

export async function recordAuditLog(entry: {
  restaurantId?: string | null;
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogs).values({
    restaurantId: entry.restaurantId ?? null,
    userId: entry.userId ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ipAddress: entry.ipAddress ?? null,
    metadata: entry.metadata,
  });
}

export type AuditLogListOptions = {
  limit?: number;
  offset?: number;
  /** Matches actions starting with this prefix, e.g. "payment." for every payment/refund event. */
  actionPrefix?: string;
  resourceType?: string;
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
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  return { logs: hasMore ? rows.slice(0, limit) : rows, hasMore, limit, offset };
}
