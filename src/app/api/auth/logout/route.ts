import { NextResponse } from "next/server";
import { getSession, destroySession } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

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
