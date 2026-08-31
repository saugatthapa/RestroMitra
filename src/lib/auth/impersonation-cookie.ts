/**
 * Just the impersonation cookie's name — split out from impersonation.ts
 * for the same reason session-cookie.ts is split from session.ts (see its
 * own comment): so anything that only needs to check whether this cookie
 * is *present*, without the Node-only DB/crypto imports, can do so
 * cheaply. Not currently read by middleware.ts (impersonation never
 * changes whether /dashboard is reachable at the optimistic-routing
 * layer — the main session cookie alone still gates that), but kept
 * separate on the same principle regardless.
 */
export const IMPERSONATION_SESSION_COOKIE_NAME = "restromitra_impersonation";
