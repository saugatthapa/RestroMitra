import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getRecentAiFailures } from "@/lib/ai/usage-db";
import { listRecentSystemErrors, clearSystemErrors } from "@/lib/system/error-log";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const AI_FAILURES_LIMIT = 25;
const SYSTEM_ERRORS_LIMIT = 25;

/**
 * Gap-audit P1 fix (Finding 3) — a simple, pragmatic "recent alerts" list:
 * recent AI provider failures (ai_usage_logs rows with success=false — see
 * getRecentAiFailures's own comment) and recent unhandled system errors
 * (the in-memory ring buffer toErrorResponse now feeds — see
 * error-log.ts's own comment on why this is an in-app substitute for
 * reading Sentry directly, which this app has no API access back into).
 * Deliberately no email/SMS/push infra here — an in-app list is the scope
 * this fix calls for; see the gap-audit finding's own "pragmatic" guidance.
 *
 * Gated MANAGE_SYSTEM — the same permission that already gates
 * /admin/system's operational-health page, since alerting is squarely
 * that same "platform ops" concern.
 */
export async function GET() {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);

    const aiFailures = await getRecentAiFailures(AI_FAILURES_LIMIT);
    const systemErrors = listRecentSystemErrors(SYSTEM_ERRORS_LIMIT);

    return NextResponse.json({ aiFailures, systemErrors });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Dismisses the in-memory "System errors" list (see error-log.ts's own
 * doc comment: it's a rolling, per-process window, not a permanent
 * record — recordAuditLog below is what actually makes this DELETE
 * durable/traceable, not the entries being cleared). Deliberately does
 * NOT touch AI provider failures — those come from ai_usage_logs, a real
 * persisted table this fix has no business bulk-deleting from a "dismiss"
 * click; that history stays intact and simply ages out of the query's own
 * recency window on its own.
 */
export async function DELETE(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);

    const clearedCount = listRecentSystemErrors(Number.MAX_SAFE_INTEGER).length;
    clearSystemErrors();

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "admin.system_errors_cleared",
      resourceType: "platform_system",
      ipAddress: getClientIp(request),
      metadata: { clearedCount },
    });

    return NextResponse.json({ cleared: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
