import "server-only";
import { asc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { restaurantSupportTags } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-error";
import type { SupportTag } from "./tags";

export type SupportTagRow = { id: string; tag: SupportTag; createdAt: Date };

export async function listSupportTags(restaurantId: string): Promise<SupportTagRow[]> {
  const rows = await db
    .select({
      id: restaurantSupportTags.id,
      tag: restaurantSupportTags.tag,
      createdAt: restaurantSupportTags.createdAt,
    })
    .from(restaurantSupportTags)
    .where(eq(restaurantSupportTags.restaurantId, restaurantId))
    .orderBy(asc(restaurantSupportTags.createdAt));
  return rows as SupportTagRow[];
}

/**
 * Idempotent — re-adding a tag that's already on this restaurant is a
 * no-op (the unique index on (restaurantId, tag) is what a double-click
 * or a second admin adding the same tag concurrently would otherwise
 * violate), not an error the UI needs to handle specially.
 */
export async function addSupportTag(params: {
  restaurantId: string;
  addedByUserId: string;
  tag: SupportTag;
}): Promise<void> {
  try {
    await db.insert(restaurantSupportTags).values({
      restaurantId: params.restaurantId,
      addedByUserId: params.addedByUserId,
      tag: params.tag,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

export async function removeSupportTag(id: string, restaurantId: string): Promise<boolean> {
  const deleted = await db
    .delete(restaurantSupportTags)
    .where(and(eq(restaurantSupportTags.id, id), eq(restaurantSupportTags.restaurantId, restaurantId)))
    .returning({ id: restaurantSupportTags.id });
  return deleted.length > 0;
}
