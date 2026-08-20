import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { SESSION_COOKIE_NAME } from "./session-cookie";

export { SESSION_COOKIE_NAME };
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export type SessionUser = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
};

export type SessionContext = {
  sessionId: string;
  user: SessionUser;
  activeRestaurantId: string | null;
};

export async function createSession(params: {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<void> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await db.insert(sessions).values({
    userId: params.userId,
    tokenHash,
    userAgent: params.userAgent ?? null,
    ipAddress: params.ipAddress ?? null,
    expiresAt,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/**
 * Resolves the current session strictly from the httpOnly cookie set by
 * createSession. There is no code path that accepts a restaurant_id,
 * user_id, or role from the request body/query for authorization purposes
 * — everything downstream (which restaurants this user can act on, with
 * which role) is derived from this session lookup against the database.
 */
async function getSessionUncached(): Promise<SessionContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);

  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      activeRestaurantId: sessions.activeRestaurantId,
      userId: users.id,
      fullName: users.fullName,
      phone: users.phone,
      email: users.email,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await destroySession();
    return null;
  }
  if (!row.isActive) return null;

  return {
    sessionId: row.sessionId,
    activeRestaurantId: row.activeRestaurantId,
    user: {
      id: row.userId,
      fullName: row.fullName,
      phone: row.phone,
      email: row.email,
    },
  };
}

/**
 * Perf audit (PERFORMANCE_AUDIT.md, Phase 25) — dashboard/layout.tsx and
 * dashboard/page.tsx both independently called getSession() (a DB round
 * trip) during the same request's render. Wrapping it in React's cache()
 * deduplicates that to a single lookup per request.
 *
 * This is safe on a shared, persistent Node process: React's cache()
 * dispatcher only exists while a Server Component tree is actively
 * rendering, and Next.js resets/tears it down when that render finishes —
 * it is NOT a global or cross-request cache. Called from anywhere outside
 * an active render (e.g. requireAuth() in rbac/guard.ts, invoked from
 * nearly every API Route Handler) there is no active dispatcher, so the
 * call just falls through to getSessionUncached() directly, uncached,
 * exactly as before this change. There is no code path by which one
 * request's session data can be returned to a different request.
 */
export const getSession = cache(getSessionUncached);

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function setActiveRestaurant(
  sessionId: string,
  restaurantId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ activeRestaurantId: restaurantId })
    .where(eq(sessions.id, sessionId));
}
