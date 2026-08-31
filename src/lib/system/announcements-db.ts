import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { platformAnnouncements } from "@/db/schema";
import { isAnnouncementCurrentlyShowable, type AnnouncementSeverity } from "./announcements";

export type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
};

const LIST_LIMIT = 100;

/** Admin console listing — every announcement, including inactive/expired ones. */
export async function listAllAnnouncements(): Promise<Announcement[]> {
  const rows = await db
    .select({
      id: platformAnnouncements.id,
      title: platformAnnouncements.title,
      body: platformAnnouncements.body,
      severity: platformAnnouncements.severity,
      isActive: platformAnnouncements.isActive,
      startsAt: platformAnnouncements.startsAt,
      endsAt: platformAnnouncements.endsAt,
      createdAt: platformAnnouncements.createdAt,
    })
    .from(platformAnnouncements)
    .orderBy(desc(platformAnnouncements.createdAt))
    .limit(LIST_LIMIT);
  return rows;
}

/**
 * The dashboard-facing read: every announcement currently within its
 * active window, newest first. Filtered in application code via
 * isAnnouncementCurrentlyShowable rather than a second copy of the same
 * date-window logic in SQL — this table is small (platform-wide, not
 * per-tenant) so fetching every row and filtering in JS is simpler and
 * cheaper to keep correct than duplicating the window math as raw SQL.
 */
export async function getActiveAnnouncements(now: Date = new Date()): Promise<Announcement[]> {
  const all = await listAllAnnouncements();
  return all.filter((a) => isAnnouncementCurrentlyShowable(a, now));
}

export async function createAnnouncement(params: {
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  startsAt: Date | null;
  endsAt: Date | null;
  createdByUserId: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(platformAnnouncements)
    .values({
      title: params.title,
      body: params.body,
      severity: params.severity,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      createdByUserId: params.createdByUserId,
    })
    .returning({ id: platformAnnouncements.id });
  return row;
}

export async function setAnnouncementActive(id: string, isActive: boolean): Promise<boolean> {
  const updated = await db
    .update(platformAnnouncements)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(platformAnnouncements.id, id))
    .returning({ id: platformAnnouncements.id });
  return updated.length > 0;
}

export async function deleteAnnouncement(id: string): Promise<boolean> {
  const deleted = await db
    .delete(platformAnnouncements)
    .where(eq(platformAnnouncements.id, id))
    .returning({ id: platformAnnouncements.id });
  return deleted.length > 0;
}
