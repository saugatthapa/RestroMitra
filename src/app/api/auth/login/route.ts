import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { loginSchema } from "@/lib/validation/auth";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const GENERIC_ERROR = "Invalid phone number or password.";

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const ip = getClientIp(request) ?? "unknown";

  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const { phone, password } = parsed.data;

  // Rate limit by IP+phone so one bad actor can't lock out a legitimate
  // user's phone number by hammering it from many IPs, nor grind through
  // many phone numbers from one IP.
  const limitedByIp = rateLimit(`login-ip:${ip}`, {
    limit: 20,
    windowMs: 60_000,
  });
  const limitedByPhone = rateLimit(`login-phone:${phone}`, {
    limit: 8,
    windowMs: 60_000,
  });
  if (!limitedByIp.allowed || !limitedByPhone.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  const rows = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);

  const user = rows[0];

  // Always run bcrypt.compare, even for a nonexistent user, against a
  // fixed dummy hash — avoids a timing side-channel that would let an
  // attacker distinguish "no such phone" from "wrong password".
  const DUMMY_HASH =
    "$2a$12$CwTycUXWue0Thq9StjUM0uJ8s8/vY.n/8p9L1e2eZ6XxJXQXQXQXe";
  const valid = await verifyPassword(
    password,
    user?.passwordHash ?? DUMMY_HASH,
  );

  if (!user || !valid || !user.isActive) {
    await recordAuditLog({
      userId: user?.id ?? null,
      action: "auth.login_failed",
      resourceType: "user",
      resourceId: user?.id,
      ipAddress: ip,
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  await createSession({
    userId: user.id,
    userAgent: request.headers.get("user-agent"),
    ipAddress: ip,
  });

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  await recordAuditLog({
    userId: user.id,
    action: "auth.login",
    resourceType: "user",
    resourceId: user.id,
    ipAddress: ip,
  });

  return NextResponse.json({ ok: true });
}
