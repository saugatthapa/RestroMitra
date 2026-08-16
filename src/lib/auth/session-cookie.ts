/**
 * Just the session cookie's name — split out from session.ts so
 * middleware.ts (which runs in the Edge Runtime) can read it without
 * pulling in session.ts's Node-only imports (the `crypto` built-in, and
 * the Postgres driver via `@/db`, which itself needs `net`/`tls`). None of
 * those are supported in the Edge Runtime, and middleware only ever needs
 * to check whether this cookie is *present* — never validate it — so it
 * has no reason to import anything heavier than this constant.
 */
export const SESSION_COOKIE_NAME = "dhankipos_session";
