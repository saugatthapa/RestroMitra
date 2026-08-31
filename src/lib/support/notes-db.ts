import "server-only";
import { desc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { restaurantSupportNotes, users } from "@/db/schema";

const NOTE_LIST_LIMIT = 100;

export type SupportNote = {
  id: string;
  note: string;
  createdAt: Date;
  authorUserId: string | null;
  authorFullName: string | null;
};

export async function listSupportNotes(restaurantId: string): Promise<SupportNote[]> {
  const rows = await db
    .select({
      id: restaurantSupportNotes.id,
      note: restaurantSupportNotes.note,
      createdAt: restaurantSupportNotes.createdAt,
      authorUserId: restaurantSupportNotes.authorUserId,
      authorFullName: users.fullName,
    })
    .from(restaurantSupportNotes)
    .leftJoin(users, eq(restaurantSupportNotes.authorUserId, users.id))
    .where(eq(restaurantSupportNotes.restaurantId, restaurantId))
    .orderBy(desc(restaurantSupportNotes.createdAt))
    .limit(NOTE_LIST_LIMIT);
  return rows;
}

export async function addSupportNote(params: {
  restaurantId: string;
  authorUserId: string;
  note: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(restaurantSupportNotes)
    .values({
      restaurantId: params.restaurantId,
      authorUserId: params.authorUserId,
      note: params.note,
    })
    .returning({ id: restaurantSupportNotes.id });
  return row;
}

/**
 * Scoped to (id, restaurantId) together — not just id — so a caller can
 * never delete a note belonging to a DIFFERENT restaurant than the one
 * they're viewing/authorized against just by guessing a note id (the
 * route only ever has restaurantId from the trusted URL param, never from
 * the note itself).
 */
export async function deleteSupportNote(id: string, restaurantId: string): Promise<boolean> {
  const deleted = await db
    .delete(restaurantSupportNotes)
    .where(and(eq(restaurantSupportNotes.id, id), eq(restaurantSupportNotes.restaurantId, restaurantId)))
    .returning({ id: restaurantSupportNotes.id });
  return deleted.length > 0;
}
