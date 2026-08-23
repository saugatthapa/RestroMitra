// RC audit P1 fix — how many reverse proxies sit in front of this app and
// are trusted to APPEND (never rewrite) an X-Forwarded-For entry before
// traffic reaches Node. Defaults to 1, matching the actual Hostinger
// single-instance deployment target (app process behind one reverse
// proxy) — see README's deployment section. Override via env only if a
// real deployment adds another hop (e.g. a CDN/WAF in front of that
// proxy) in front of it.
const TRUSTED_PROXY_COUNT = (() => {
  const raw = Number(process.env.TRUSTED_PROXY_COUNT ?? "1");
  return Number.isInteger(raw) && raw >= 0 ? raw : 1;
})();

/**
 * Resolves the request's client IP for use as a rate-limit key and for
 * audit-log attribution.
 *
 * RC audit P1 fix — this used to trust the LEFTMOST X-Forwarded-For entry
 * verbatim, which is exactly the part of the header a client controls
 * directly: X-Forwarded-For is built left-to-right as "client-supplied
 * value (if any), then each proxy's own observed remote address,
 * appended" — so a request that arrives with
 * `X-Forwarded-For: 9.9.9.9, <real proxy-observed IP>` has its fake
 * leading entry trusted as "the" client IP. Every IP-keyed rate limit in
 * this app (login attempts, gateway-callback abuse, public order-page
 * throttling, etc.) could be defeated by simply rotating that header on
 * each request.
 *
 * Only entries actually APPENDED by this deployment's own trusted proxy
 * chain are reliable — there are exactly TRUSTED_PROXY_COUNT of those,
 * counted from the RIGHT (the end closest to us), never the left. A
 * client can prepend as many fake entries as it wants; it cannot remove
 * or rewrite the ones the real proxy chain appends after it.
 */
export function getClientIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const ips = forwardedFor
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (ips.length === 0) return null;
    const index = ips.length - TRUSTED_PROXY_COUNT;
    if (index >= 0 && index < ips.length) return ips[index];
    // Fewer entries than the configured trusted-hop count (a
    // misconfiguration, or a direct request that skipped the proxy
    // entirely) — fall back to the rightmost entry, the one closest to us
    // and hardest for a client to forge, rather than the fully
    // client-controlled leftmost one.
    return ips[ips.length - 1] ?? null;
  }
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
