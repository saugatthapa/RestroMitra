/**
 * Platform Control Center (Phase 10) — pure "is this announcement showable
 * right now" math, dependency-free (no "server-only", no DB import) so
 * it's directly unit-testable and shared between the DB read path
 * (announcements-db.ts) and anywhere else that might need the same
 * answer without a fresh query (e.g. a client component re-checking after
 * a local clock tick).
 */
export type AnnouncementWindow = {
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export function isAnnouncementCurrentlyShowable(
  announcement: AnnouncementWindow,
  now: Date = new Date(),
): boolean {
  if (!announcement.isActive) return false;
  if (announcement.startsAt && announcement.startsAt.getTime() > now.getTime()) return false;
  if (announcement.endsAt && announcement.endsAt.getTime() < now.getTime()) return false;
  return true;
}

export type AnnouncementSeverity = "info" | "warning" | "critical";

export const ANNOUNCEMENT_SEVERITIES: AnnouncementSeverity[] = ["info", "warning", "critical"];
