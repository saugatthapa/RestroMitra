import { NextResponse } from "next/server";
import { getSession, destroySession } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { toErrorResponse } from "@/lib/api-route-helpers";

// QA hardening (P2 backlog): see login/route.ts's comment for why every
// pre-auth route now wraps its body in try/catch + toErrorResponse —
// consistent JSON error shape and Sentry reporting on truly unexpected
// failures, no behavior change on any explicit return path.
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    return await handleLogout(request);
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function handleLogout(request: Request) {
  const session = await getSession();
  await destroySession();

  if (session) {
    await recordAuditLog({
      userId: session.user.id,
      action: "auth.logout",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
    });
  }

  return NextResponse.json({ ok: true });
}
