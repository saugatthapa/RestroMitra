# Security

This document describes RestroMitra's actual security posture: how tenant
and branch data is isolated, how access control and sessions work, what
protections are in place at the network/header level, and what is
logged. It consolidates what used to live only as scattered notes in
`README.md`'s "Security notes" section, and reflects what the code
actually does today rather than an aspirational target.

## Reporting a security vulnerability

If you find a security issue, please report it directly to the
maintainer rather than opening a public GitHub issue. There is no bug
bounty program at this time. Include enough detail to reproduce the
issue (affected route/feature, request shape, expected vs. actual
behavior) so it can be triaged quickly.

## Tenant isolation

RestroMitra is multi-tenant: every restaurant's data (menu, orders,
staff, inventory, reports, ...) must be reachable only by users with an
active role grant at that specific restaurant.

- **A `restaurant_id` is never trusted from the client for
  authorization.** Every restaurant-scoped API route resolves the
  restaurant from a server-side source — typically its slug, looked up
  against the database — and then calls into `src/lib/rbac/guard.ts`'s
  `requireRestaurantAccess()` (directly, or via the
  `resolveRestaurantContext()` helper in
  `src/lib/api-route-helpers.ts`, which is the standard entry point for
  restaurant-scoped routes).
- `requireRestaurantAccess()` looks for an **active** `user_roles` row
  for the authenticated user at that exact restaurant. A caller can
  never simply assert "I am restaurant X" — there is no other code path
  that grants tenant access. At most one active role grant can exist per
  `(user, restaurant)` pair, enforced both in application code and by a
  database unique index.
- `platform_admin` / `super_admin` roles bypass the per-restaurant grant
  check by design, for platform support/operations. Every action taken
  this way must still be — and is — written to `audit_logs` by the
  calling route; the bypass grants access, not exemption from logging.
- A restaurant can be **suspended** by a platform admin
  (`restaurants.isActive`); `requireRestaurantActive()` blocks every
  staff-facing route for a suspended tenant (platform admins and active
  impersonation sessions are exempt, so support can still investigate a
  suspended account).
- A restaurant's **subscription status** is enforced the same way
  (`requireActiveSubscription()`) — an expired/cancelled subscription
  blocks tenant-scoped routes except billing itself, again with a
  platform-admin/impersonation exemption.
- A platform-wide **maintenance mode** flag, when enabled, blocks every
  tenant-scoped route for everyone except platform admins and active
  impersonation sessions — the intended "break-glass" access path during
  planned downtime. Every audit log entry recorded while maintenance
  mode is active is separately tagged `duringMaintenanceMode: true` for
  traceability.

## Branch isolation

Restaurants with multiple branches add a second, narrower isolation
layer on top of tenant isolation:

- A role grant can be scoped to one specific `branch_id`, or left
  unrestricted (`null`, meaning "every branch of this restaurant").
  `requireBranchAccess()` in `src/lib/rbac/guard.ts` verifies both that
  the target branch actually belongs to the trusted `restaurant_id` in
  scope, and that the caller's own grant covers it.
- Actions that legitimately span two branches (e.g. approving a stock
  transfer between branches) use `requireEitherBranchAccess()`, which
  requires the caller to have access to at least one of the two branches
  involved — never a bypass of the check, just its two-sided form.
- A resource whose own branch assignment can itself be `null` (an
  unrestricted staff/payroll grant) is checked with
  `requireBranchAccessForNullableTarget()`, which fails closed: only an
  unrestricted caller may act on an unrestricted target, so a
  branch-scoped manager can never reach into a grant that isn't
  legitimately "theirs."

## Role-based access control (RBAC)

- Roles (owner, manager, waiter, cashier, kitchen_staff, and others) are
  granted permissions via a `role_permissions` table
  (`DEFAULT_ROLE_PERMISSIONS` in `src/lib/rbac/permissions.ts`).
  `requirePermission()` / `requireAnyPermission()` in
  `src/lib/rbac/guard.ts` are the enforcement points; `owner` and
  `platform_admin` are always allowed, every other role is checked
  against its actual grants.
- Permission checks fail closed: an empty permission set, an unknown
  role, or a missing grant all result in a denial, never a default
  allow.
- Sensitive feature areas require a specific permission for **both
  reads and writes** — for example, the entire inventory subsystem
  (suppliers, stock items, purchases, recipes) requires
  `MANAGE_INVENTORY`; cost/margin fields are further gated behind
  `VIEW_PROFIT`. Refunds require a higher-tier permission
  (`REFUND_ORDER`) than recording an ordinary payment (`EDIT_ORDER`),
  and every payment/refund amount is re-validated server-side against
  the live order ledger rather than trusted from the client.
- Staff management refuses to let a caller modify an `owner` /
  `platform_admin` grant, or deactivate their own access, through the
  ordinary staff-management routes.
- **Platform-level roles** (the internal admin/support console) are a
  separate permission catalog (`src/lib/rbac/platform-permissions.ts`)
  from tenant-scoped roles, resolved through
  `requirePlatformAdmin()` / `requirePlatformPermission()`. Every
  platform role additionally **requires MFA to be enabled** on the
  account before it grants access — checked at the point of access, not
  left as an optional setting, because even the narrowest platform role
  can read data across every tenant.

## Impersonation (platform support access)

Platform admins can temporarily act as a specific restaurant for
support/operations purposes, through a mechanism deliberately kept
separate from normal login sessions (`src/lib/auth/impersonation.ts`):

- Starting an impersonation session requires a permission check
  (`IMPERSONATE_TENANT` / `IMPERSONATE_TENANT_WRITE`), a **non-empty,
  recorded reason**, and creates a scoped, time-boxed grant (30 minutes)
  rather than a new identity — the admin's own login/session and
  platform-level identity are untouched throughout.
- A database-level unique constraint prevents an admin from holding more
  than one active impersonation session at a time (no nested
  impersonation).
- Impersonation is scoped to exactly one target restaurant and to a
  mode: **read-only** (granted only `view_*` permissions) or **write**
  (full access to that one restaurant, equivalent to `owner` there for
  the duration of the grant). A read-only session can never escalate
  itself to a write action.
- Every action taken during an active impersonation session is tagged in
  `audit_logs` with `isImpersonated: true`, the impersonation session id,
  and the stated reason — so impersonated actions are always
  distinguishable from the admin's own platform-level actions after the
  fact.
- Sessions expire server-side (not just via the cookie) and can be
  force-ended by another platform admin (`revokeImpersonationSession()`)
  — the impersonating admin's browser stops working on its very next
  request once revoked or expired, it does not need to be revalidated
  by the admin themselves.
- "Exit impersonation" always resolves the session to end from the
  requester's own cookie, so it can never be used to end someone else's
  session.

## Session security

- Passwords are hashed with bcrypt (cost factor 12).
- Session tokens are high-entropy random values (256-bit,
  `crypto.randomBytes`), stored server-side only as their SHA-256 hash —
  the raw token exists only in the browser's `httpOnly` cookie. Sessions
  are revocable: logging out deletes the server-side session row, not
  just the cookie.
- Session cookies are `httpOnly`, `SameSite=Lax`, and `secure` in
  production.
- Password-reset tokens use the same random-token-plus-hash primitives
  as session tokens, and are single-use.
- **Multi-factor authentication (MFA)** is TOTP-based (RFC 6238,
  compatible with standard authenticator apps), implemented in
  `src/lib/auth/mfa.ts`:
  - Enrollment requires proving a live code against the not-yet-trusted
    secret before it's activated.
  - A used TOTP code can never be replayed: the last-accepted time step
    is tracked per user and verification happens under a row lock, so
    two concurrent login attempts with the same still-valid code cannot
    both succeed.
  - Ten single-use backup codes are issued on enrollment (and can be
    regenerated), for recovery if the authenticator device is
    unavailable.
  - MFA is **mandatory** for every platform-level (internal admin)
    role, and available as an option for tenant accounts.
- Every JSON API route additionally requires a custom
  `x-restromitra-client` request header as CSRF defense-in-depth,
  alongside the `SameSite=Lax` cookie policy.

## Rate limiting

Auth endpoints (login, register) and other abuse-prone surfaces (the
public QR order endpoint, payment-gateway callbacks) are rate-limited
per IP and/or per identifying key.

**Current state, stated plainly:** the rate limiter
(`src/lib/rate-limit.ts`) is in-memory and correct only for a
single-process deployment — it has no code-level guard against a second
process or instance, so deploying to a horizontally-scaled platform (or
running a process manager in cluster mode) silently multiplies every
limit by the instance count rather than erroring. A parallel workstream
in this same effort is adding an optional distributed (Redis/Upstash-backed)
mode so this holds under a multi-instance deployment too; until that
ships, treat rate limiting as effectively single-instance-only and see
"Known limitations" below.

## Security headers and Content Security Policy

`next.config.ts` sets the following on every response:

- `Content-Security-Policy` — `default-src 'self'`, with `object-src
  'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `block-all-mixed-content`, and `upgrade-insecure-requests`.
  `form-action` explicitly allow-lists eSewa's hosted payment-form
  endpoints (a real cross-origin `<form>` submission the checkout flow
  depends on) in addition to `'self'`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy` disables camera, microphone, geolocation,
  payment, USB, MIDI, and FLoC (`interest-cohort`).
- `Strict-Transport-Security` at 180 days, including subdomains,
  deliberately **without** `preload` (preload-list submission is a
  hard-to-reverse, domain-wide commitment left to whoever owns the
  production domain).

**Known, deliberate gap:** `script-src` and `style-src` both include
`'unsafe-inline'`. This is a real gap in XSS defense-in-depth — this CSP
does not block a successful inline-script injection. It is not an
oversight: removing it requires nonce-based CSP, which in turn requires
every page to render dynamically (defeating static optimization for the
public QR-order pages, the public website builder, `/login`,
`/register`, and the print/KOT pages) and a refactor of this codebase's
existing inline `style={{...}}` usages. Every other CSP directive is as
strict as the app's actual code allows. Tightening this — nonce-based
CSP plus the inline-style refactor — is real, tracked follow-up work,
not something silently deferred without acknowledgment.

Error-monitoring traffic (see below) is tunneled through this app's own
origin rather than sent directly to a third-party host, specifically so
it works under `connect-src 'self'` without loosening the CSP.

## Error monitoring

Sentry is fully wired (`instrumentation.ts`,
`instrumentation-client.ts`, `sentry.server.config.ts`,
`sentry.edge.config.ts`) but ships **inert** until `SENTRY_DSN` (and
`NEXT_PUBLIC_SENTRY_DSN` for the browser) are configured — see
`SENTRY_SETUP.md` for setup steps. When enabled:

- Request/response bodies and cookies are excluded from collection
  entirely at the SDK level, not just filtered after capture.
- A shared `beforeSend` hook (`src/lib/sentry-redact.ts`, unit tested)
  redacts known-sensitive fields (passwords, phone numbers, customer
  names, emails, tax IDs, session/auth tokens and headers) from whatever
  data remains, plus specifically redacts the QR-order access token out
  of any captured URL.
- The application logs a one-time startup warning
  (`console.warn` from `instrumentation.ts`) when running in production
  with no `SENTRY_DSN` set, so silently-disabled monitoring is never a
  silent surprise.

## Audit logging

Sensitive actions are recorded to an append-only `audit_logs` table
(`src/lib/audit.ts`): authentication events, restaurant creation, order
status changes, every payment and refund, staff/permission changes, and
platform-level actions (role grants, plan/feature-flag edits,
impersonation, suspension). Each entry records the actor, the action,
the affected resource, the originating IP, and free-form metadata; entries
made under an active impersonation session or platform maintenance mode
are auto-tagged as such. Tenant-scoped and platform-wide audit log views
are both available to the appropriate role (restaurant owners/managers
for their own restaurant; platform admins across every tenant).

## Data privacy and retention

See `PRIVACY.md`, `TERMS.md`, and `DATA_RETENTION.md` at the repo root
for the data-handling policy — customer/staff PII covered, retention
periods, and deletion requests. These are being finalized in a parallel
workstream alongside this document.

## Known limitations

Being direct about what is not yet at its target state:

- **Rate limiting is in-memory and single-instance only** (see above).
  Do not deploy this app to a horizontally-scaled/serverless platform or
  a multi-process cluster without first swapping in the distributed
  backend that is in progress.
- **CSP allows `'unsafe-inline'`** for scripts and styles (see above) —
  a real, acknowledged reduction in XSS defense-in-depth pending a
  nonce-based CSP migration.
- **HSTS preload is not submitted.** `Strict-Transport-Security` is set
  without `preload`; submitting the production domain to browsers'
  preload lists is a separate, deliberate decision left to whoever owns
  the domain.
- **Error monitoring requires manual setup.** Sentry is fully coded but
  reports nowhere until `SENTRY_DSN` is configured for a given
  deployment; the startup warning above exists specifically to make that
  visible rather than silent.
- **No SMS-based second factor.** MFA is authenticator-app (TOTP) only;
  there is no SMS/OTP delivery path in this app today.
- **Reverse-proxy header pass-through is unverified for every hosting
  target.** The security headers above are set by the Next.js app
  itself; whether a given reverse proxy in front of it (e.g. a shared
  hosting provider's own proxy layer) passes them through unmodified
  should be confirmed against each live deployment.
