import "server-only";
import { count, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@/lib/subscription";

export type SystemHealth = {
  db: { ok: boolean; latencyMs: number };
  restaurants: {
    total: number;
    active: number;
    suspended: number;
    byStatus: Record<SubscriptionStatus, number>;
  };
  signupsLast24h: number;
  appUptimeSeconds: number;
  serverTime: Date;
};

/**
 * Platform Control Center (Phase 10) — the /admin/system health page's
 * data source. Deliberately simple, explainable operational signals (same
 * philosophy as Phase 9's health score: named numbers a human can read
 * directly) rather than a full observability stack this single-instance
 * deployment doesn't have — see request.ts's TRUSTED_PROXY_COUNT comment
 * for the deployment shape this is built for. `db.latencyMs` doubles as
 * the actual health check: if this query fails, the route's own
 * try/catch reports `db.ok: false` rather than throwing a raw 500.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const dbCheckStart = Date.now();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbCheckStart;

  const [totalRow] = await db.select({ n: count() }).from(restaurants);
  const [suspendedRow] = await db
    .select({ n: count() })
    .from(restaurants)
    .where(eq(restaurants.isActive, false));

  const byStatus = {} as Record<SubscriptionStatus, number>;
  for (const status of SUBSCRIPTION_STATUSES) {
    const [row] = await db
      .select({ n: count() })
      .from(restaurants)
      .where(eq(restaurants.subscriptionStatus, status));
    byStatus[status] = row?.n ?? 0;
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [signupsRow] = await db
    .select({ n: count() })
    .from(restaurants)
    .where(gte(restaurants.createdAt, twentyFourHoursAgo));

  const total = totalRow?.n ?? 0;
  const suspended = suspendedRow?.n ?? 0;

  return {
    db: { ok: dbOk, latencyMs: dbLatencyMs },
    restaurants: {
      total,
      active: total - suspended,
      suspended,
      byStatus,
    },
    signupsLast24h: signupsRow?.n ?? 0,
    appUptimeSeconds: Math.round(process.uptime()),
    serverTime: new Date(),
  };
}
