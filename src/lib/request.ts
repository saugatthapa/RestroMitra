export function getClientIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() ?? null;
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return null;
}

/**
 * Lightweight CSRF defense-in-depth for JSON API routes: browsers cannot
 * set arbitrary custom headers on a cross-site simple form submission, so
 * requiring this header (in addition to SameSite=Lax session cookies)
 * blocks classic cross-site form-post CSRF against these endpoints.
 */
export function hasValidCsrfHeader(request: Request): boolean {
  return request.headers.get("x-restromitra-client") === "web";
}
