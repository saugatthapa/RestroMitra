import "server-only";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";

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
