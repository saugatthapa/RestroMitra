import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuItems } from "@/db/schema";

export async function getOwnedMenuItem(restaurantId: string, itemId: string) {
  const rows = await db
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}
