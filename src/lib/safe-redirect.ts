/**
 * Guards client-side "redirect back to where you came from" flows (today:
 * the login page's `?next=` param, set server-side by middleware.ts when it
 * bounces an unauthenticated visitor away from a protected route — see that
 * file's `url.searchParams.set("next", pathname)`).
 *
 * middleware.ts only ever writes a same-origin pathname into `next`, but the
 * login page reads it back out of the URL via `useSearchParams()` — and a
 * URL's query string is attacker-controlled the moment it's shared as a
 * link, regardless of what the app itself would ever generate. Without this
 * check, `/login?next=https://evil.com` (or `//evil.com`, which browsers
 * also treat as a protocol-relative absolute URL) would make a successful
 * login silently redirect the user's already-authenticated browser straight
 * off-site — a classic open-redirect phishing vector. `router.push()` to a
 * cross-origin URL is a real full-page navigation in Next.js, not a no-op,
 * so this isn't a theoretical concern.
 *
 * Only a path that starts with exactly one `/` (never `//` or `/\`, both of
 * which browsers can resolve as scheme-relative absolute URLs) and contains
 * no embedded scheme is considered safe. Anything else falls back to
 * `fallback`.
 */
export function safeInternalRedirect(
  value: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!value) return fallback;
  // QA hardening pass — reject any embedded ASCII control character
  // (tab/newline/CR chief among them) BEFORE the slash/scheme checks
  // below. Per the WHATWG URL spec (implemented identically by every
  // browser and by Node's own URL parser), these bytes are stripped
  // during parsing — so a value like "/\t/evil.com" sails past every
  // check below (it starts with a single "/", not "//" or "/\", and has
  // no colon), but Next's client router's own `new URL(value, location.href)`
  // call strips the tab and re-parses it as "//evil.com" — a genuine
  // scheme-relative, off-origin URL, triggering a real top-level
  // navigation off-site right after a successful login/MFA. Stripping
  // isn't enough (the resulting collapsed value could still resolve
  // off-origin); rejecting outright is what actually closes this.
  if (/[\u0000-\u001f]/.test(value)) {
    return fallback;
  }
  // Must start with a single "/" — reject "//host/path", "/\host/path"
  // (some browsers normalize backslashes to forward slashes), and anything
  // that isn't even path-like ("https://...", "javascript:...").
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  // Reject an embedded scheme like "/\t/javascript:alert(1)" or a value
  // that smuggles a scheme past the leading slash check via encoded/odd
  // characters — belt-and-suspenders alongside the checks above.
  if (/^\/+[^/]*:/.test(value)) {
    return fallback;
  }
  return value;
}
