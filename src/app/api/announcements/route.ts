import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac/guard";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getActiveAnnouncements } from "@/lib/system/announcements-db";

/**
 * Platform Control Center (Phase 10) — the dashboard-facing read: every
 * platform announcement currently within its active window. Any logged-in
 * user may read this (requireAuth only, no permission check) — an
 * announcement is by definition meant for every tenant's staff to see,
 * not a support/admin-only artifact like Phase 9's internal notes.
 */
export async function GET() {
  try {
    await requireAuth();
    const announcements = await getActiveAnnouncements();
    return NextResponse.json({ announcements });
  } catch (err) {
    return toErrorResponse(err);
  }
}
