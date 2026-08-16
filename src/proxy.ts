import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

/**
 * Optimistic routing only — this checks for the *presence* of a session
 * cookie, not its validity. Real authentication/authorization is always
 * re-verified server-side (DB-backed session + RBAC lookup) in the page
 * or route handler itself. Never rely on this file for actual access
 * control; see src/lib/rbac/guard.ts for that.
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = Boolean(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  const { pathname } = request.nextUrl;

  const isProtectedPath =
    pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding");
  const isAuthPage = pathname === "/login" || pathname === "/register";

  if (isProtectedPath && !hasSessionCookie) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthPage && hasSessionCookie) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/onboarding/:path*", "/login", "/register"],
};
