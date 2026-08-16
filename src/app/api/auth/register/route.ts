import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { registerSchema } from "@/lib/validation/auth";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const ip = getClientIp(request) ?? "unknown";
  const limited = rateLimit(`register:${ip}`, { limit: 5, windowMs: 60_000 });
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const { fullName, phone, email, password } = parsed.data;

  const passwordIssue = validatePasswordStrength(password);
  if (passwordIssue) {
    return NextResponse.json({ error: passwordIssue }, { status: 400 });
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);

  if (existing.length > 0) {
    // Deliberately generic message — do not reveal whether a phone number
    // is registered to an unauthenticated caller.
    return NextResponse.json(
      { error: "Could not create account with these details." },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({
      fullName,
      phone,
      email: email && email.length > 0 ? email : null,
      passwordHash,
    })
    .returning({ id: users.id });

  await createSession({
    userId: user.id,
    userAgent: request.headers.get("user-agent"),
    ipAddress: ip,
  });

  await recordAuditLog({
    userId: user.id,
    action: "auth.register",
    resourceType: "user",
    resourceId: user.id,
    ipAddress: ip,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
