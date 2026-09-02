import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createAnnouncementSchema } from "@/lib/validation/system";
import { listAllAnnouncements, createAnnouncement } from "@/lib/system/announcements-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/** Platform Control Center (Phase 10) — platform-wide announcements, shown on every tenant's dashboard. */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ANNOUNCEMENTS);

    // QA hardening (P2 backlog) — see ai-providers/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const announcements = await listAllAnnouncements();
    return NextResponse.json({ announcements });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ANNOUNCEMENTS);

    const parsed = await parseJsonBody(request, createAnnouncementSchema);
    if (!parsed.ok) return parsed.response;
    const { title, body, severity, startsAt, endsAt } = parsed.data;

    const created = await createAnnouncement({
      title,
      body,
      severity: severity as "info" | "warning" | "critical",
      startsAt,
      endsAt,
      createdByUserId: session.user.id,
    });

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "admin.announcement_created",
      resourceType: "platform_announcement",
      resourceId: created.id,
      ipAddress: getClientIp(request),
      metadata: { title, severity },
    });

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
