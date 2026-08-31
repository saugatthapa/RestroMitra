import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformMaintenanceMode, users } from "@/db/schema";

export type MaintenanceModeState = {
  enabled: boolean;
  message: string | null;
  reason: string | null;
  enabledAt: Date | null;
  enabledByName: string | null;
};

/**
 * Reads the singleton maintenance-mode row, creating it (disabled) on
 * first read if it doesn't exist yet — this table ships with no seed
 * migration (see schema.ts's own comment), so a fresh environment simply
 * has no row until the first call here, which is always "maintenance
 * mode is off."
 */
export async function getMaintenanceMode(): Promise<MaintenanceModeState> {
  const [row] = await db
    .select({
      enabled: platformMaintenanceMode.enabled,
      message: platformMaintenanceMode.message,
      reason: platformMaintenanceMode.reason,
      enabledAt: platformMaintenanceMode.enabledAt,
      enabledByName: users.fullName,
    })
    .from(platformMaintenanceMode)
    .leftJoin(users, eq(platformMaintenanceMode.enabledByUserId, users.id))
    .where(eq(platformMaintenanceMode.id, true))
    .limit(1);

  if (row) return row;

  await db
    .insert(platformMaintenanceMode)
    .values({ id: true, enabled: false })
    .onConflictDoNothing();

  return { enabled: false, message: null, reason: null, enabledAt: null, enabledByName: null };
}

/**
 * Turning maintenance mode ON always requires a reason (spec-consistent
 * with every other sensitive platform toggle in this project — suspend,
 * impersonate); turning it OFF does not, since there's nothing to
 * justify about restoring normal service.
 */
export async function setMaintenanceMode(params: {
  enabled: boolean;
  message: string | null;
  reason: string | null;
  userId: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(platformMaintenanceMode)
    .values({
      id: true,
      enabled: params.enabled,
      message: params.message,
      reason: params.reason,
      enabledByUserId: params.userId,
      enabledAt: params.enabled ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformMaintenanceMode.id,
      set: {
        enabled: params.enabled,
        message: params.message,
        reason: params.reason,
        enabledByUserId: params.userId,
        enabledAt: params.enabled ? now : null,
        updatedAt: now,
      },
    });
}
