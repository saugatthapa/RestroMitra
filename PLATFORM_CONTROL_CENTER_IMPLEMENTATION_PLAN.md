# RestroMitra Platform Control Center + Attendance Overhaul — Implementation Plan

Response to the pasted ChatGPT conversation and the instruction: *"use this as your
prompt. first analyse our conversation in deep and understand what we are aiming
and looking for, after that create a complete implementation plan with end to end
workflow, after all that you can start developing and coding."*

This document is step 2 of that instruction (analysis + plan). Step 3 (development)
begins immediately after, starting with Phase 1 below, in this same session.

## 0. What you're actually asking for, in plain terms

Strip the ChatGPT transcript's ~80 sections down to two things:

1. **A second admin product** — a SaaS-owner control panel, separate from every
   restaurant's own dashboard, to manage tenants, subscriptions, plans/entitlements,
   feature rollout, AI provider costs, support, and platform-level audit — the way
   you'd run RestroMitra as a business, not as a restaurant.
2. **A real staff attendance system** — selfie-verified clock-in/out with proper
   photo storage, leave/holiday/day-off management, an approval workflow, a status
   model beyond present/absent, and a bridge from all of that into payroll — instead
   of today's bare clock-in/clock-out timestamp pair.

Both are real, both are large, and neither is a bug fix — they're new product
surfaces. Section 0 of your own prompt already anticipated this and was explicit:
inspect the current repo first, reuse what exists, don't duplicate, plan before
coding. That inspection is done (three read-only audits, summarized in §1-2 below).

**Honest scope framing, since I know this is a live conversation and you should
set expectations accordingly**: this is realistically 15-20 solid implementation
phases. I'm not going to build all of it in one pass and then tell you it's done —
that's exactly what your prompt's own Section 79 ("Critical Rule") forbids. I'll
build it in the same verified, tested, committed-locally increments this whole
engagement has used, phase by phase, and tell you honestly at each point what's
built, what's tested, and what's still open. You can redirect priority at any
point — e.g. if attendance matters more to you right now than the platform admin
panel, say so and I'll reorder.

## 1. What already exists and will be reused (not rebuilt)

| Capability | Where | Reuse plan |
|---|---|---|
| Platform-admin identity | `systemRoleEnum` "platform_admin" value; a `userRoles` row with `restaurantId = NULL` | Keep as the identity primitive. Add a real grant/revoke path (today only raw SQL can create one — a genuine gap). |
| Platform-admin authorization | `isPlatformAdmin()`/`requirePlatformAdmin()` in `src/lib/rbac/guard.ts`; bypasses `roleHasPermission()`'s matrix entirely | Too coarse for the new panel (today it's all-or-nothing). Add a `PLATFORM_PERMISSIONS` catalog + `requirePlatformPermission()` alongside it, mirroring the existing tenant RBAC pattern, so SUPER_ADMIN/PLATFORM_ADMIN/SUPPORT_ADMIN/BILLING_ADMIN/PLATFORM_VIEWER can be distinguished. |
| Admin UI/API skeleton | `src/app/admin/**`, `src/app/api/admin/restaurants/**` | Extend in place under the same `/admin` route (not a new `/platform` tree — avoids duplicating a working, already-gated layout). Add sub-areas: tenants (exists, extend), plans, entitlements, AI provider config, audit log viewer, impersonation, support tools. |
| Sessions | DB-backed `sessions` table, sha256 hash, httpOnly/secure cookie, `getSession()`/`requireAuth()`, revocation helpers | Reused as-is for platform admins. No separate auth system. |
| MFA | TOTP via otplib, `users.mfaEnabled`, currently optional | Add a hard *require* gate for anyone holding `platform_admin` — checked at `requirePlatformAdmin()` time, not just at login. |
| Audit log | `recordAuditLog()` already takes `restaurantId: string | null` | Reused directly as the platform audit log's write path. `listAuditLogs()` needs a new nullable-restaurantId query variant for a viewer UI. |
| Rate limiting / CSRF / security headers | `src/lib/rate-limit.ts`, `src/lib/request.ts`, `next.config.ts` | Apply as-is to every new route; headers already cover new paths automatically. |
| Price grandfathering pattern | `lockedMonthlyPriceInPaisa` on the restaurant/subscription row | Precedent to follow for per-tenant entitlement overrides (same "explicit override row, audited, doesn't touch the base plan" shape). |
| Attendance math contract | `summarizeAttendance()` in `src/lib/attendance.ts` → `{totalMinutes, daysPresent}`, consumed by `src/lib/payroll.ts` | New status/leave model must extend this contract without breaking payroll's existing consumer. |

## 2. What's genuinely greenfield (no existing infrastructure)

- **4-layer entitlement engine** — RBAC (exists) is "who"; nothing today answers
  "what did this tenant buy" (plan features are just display strings, not
  enforced), "what's platform-rolled-out" (no feature flags exist), or "what
  override applies to this one tenant" (no override table exists). This is new
  schema + a new resolution function, not a UI feature.
- **Object storage for attendance photos** — every existing "image" in this
  codebase (logos, menu photos) is a base64 data-URL in a Postgres `text` column.
  That's unacceptable for selfies (privacy-sensitive, needs retention/deletion,
  needs signed short-lived access, not public). This needs a real storage
  subsystem — private bucket + signed URLs — built from nothing.
- **Encrypted secret storage** — AI provider keys and payment gateway keys are
  both plain `process.env` reads today. A DB-backed, encrypted-at-rest AI
  provider config (with failover/cost-tracking) is new infrastructure.
- **Impersonation** — does not exist in any form. Needs its own session/audit
  semantics (not a session swap — a visibly-banner-flagged, reason-required,
  every-mutation-tagged secondary session).
- **Leave / holiday / day-off / schedule model** — `attendanceRecords` today is
  just clock-in/clock-out/note. No status enum, no leave requests, no holidays,
  no schedules. Fully new tables.
- **Attendance photo capture + verification review UI** — new staff-facing and
  owner-facing screens.

## 3. Design decisions this plan is making (stated so you can veto any of them)

1. **Extend `/admin`, don't create a parallel `/platform` tree.** Your ChatGPT
   draft assumed a from-scratch `/platform/login` + `/platform/dashboard`. A
   working, tested, gated skeleton already exists at `/admin`. Building a second
   parallel one would violate your own Section 0 ("do not duplicate"). I'll grow
   `/admin` into the full control center instead. If you specifically want the
   `/platform` URL/brand for user-facing reasons (e.g. it's customer-visible), say
   so and I'll rename — it's a mechanical rename, not an architectural one.
2. **One role enum, graded permissions.** Rather than 5 separate Postgres enum
   values (SUPER_ADMIN/PLATFORM_ADMIN/SUPPORT_ADMIN/BILLING_ADMIN/
   PLATFORM_VIEWER), I'll keep a small role set on the existing `systemRoleEnum`
   (add SUPER_ADMIN, SUPPORT_ADMIN, BILLING_ADMIN, PLATFORM_VIEWER alongside the
   existing platform_admin — treating platform_admin as today's "full access"
   role) and drive fine-grained differences through the new `PLATFORM_PERMISSIONS`
   catalog, matching exactly how tenant-side RBAC already works. This is more
   consistent with the rest of the codebase than a second, differently-shaped role
   system.
3. **Photo storage: S3-compatible object storage via signed URLs**, provider
   configurable via env (works with AWS S3, Cloudflare R2, or Backblaze B2 without
   code changes — all speak the S3 API). This needs one new env-configured
   dependency; I'll flag the exact env vars needed when I get to that phase, since
   you'll need to provision a bucket.
4. **AI provider secrets: encrypted at rest with a server-held key** (AES-256-GCM,
   key from an env var — `AI_CONFIG_ENCRYPTION_KEY` — never the value itself in
   DB, logs, or any API response). Decrypted only at the point of calling the
   provider API.
5. **Attendance status model**: extend, don't replace. `attendanceRecords` keeps
   its clock-in/out shape (open shifts, payroll's existing consumer) and gains a
   `status` enum column plus companion tables for leave requests, holidays, and
   schedules — `summarizeAttendance()` is extended to fold these in, with its
   existing two-field return shape preserved as a subset so payroll doesn't break.

## 4. Phased build order

Grounded in dependency order (each phase needs the one before it), not the
ChatGPT draft's assumed order. Each phase = schema + server logic + tests + (UI
where applicable) + local commit, verified before moving on, matching how the
rest of this engagement has worked.

**Track A — Platform Control Center**
1. Platform authorization realm: `PLATFORM_PERMISSIONS` catalog, `requirePlatformPermission()`, real grant/revoke for platform roles, hard MFA gate. *(Starting now — see §5.)*
2. Platform dashboard shell + tenant management (extend existing `/admin`): search/filter, detail view, suspend/reactivate (reversible, data-preserving).
3. Subscription state machine (TRIALING/ACTIVE/PAST_DUE/GRACE_PERIOD/PAUSED/CANCELLED/EXPIRED/SUSPENDED) + trial management (extend/shorten/convert).
4. Plan management (data-driven, replacing hardcoded plan checks) + feature catalog.
5. Entitlement engine: plan entitlements + feature flags + per-tenant overrides (audited, PLAN vs PLATFORM_OVERRIDE sourcing) + an "explain this tenant's access" debug screen.
6. Platform audit log viewer (nullable-restaurantId query + UI).
7. AI Provider Control Center: encrypted config storage, provider abstraction/failover, usage/cost tracking, per-tenant AI limits.
8. Impersonation: separate session, banner, mandatory reason, mutation tagging, one-click exit.
9. Support tooling: global search, internal notes, session revocation, support-status tags, simple explainable health score.
10. Platform announcements, `/admin/system` health page, maintenance mode, break-glass access for the most sensitive ops.
11. Security test pass: platform isolation, override isolation, expired-tenant premium-endpoint denial, plan-limit enforcement, impersonation authorization, audit completeness.

**Track B — Attendance overhaul** *(can interleave with Track A or run after — your call when we get there)*
12. Object storage subsystem (signed URLs, retention/deletion) + selfie capture UI, with the Nepal Privacy Act consent notice gating the feature on.
13. Attendance status model + owner verification review screen (VERIFIED/NEEDS_REVIEW/REJECTED) + correction-with-reason audit trail.
14. Holidays + staff day-off assignment + leave request/approval workflow.
15. Staff scheduling + schedule-vs-actual comparison (late/early-departure/overtime derivation).
16. Attendance analytics (owner aggregate + per-employee) + attendance→payroll integration (scheduled vs actual, overtime, paid/unpaid leave — no invented statutory rules).
17. Plan-gated attendance tiers (via the Track A entitlement engine — this is why Track A's entitlement work benefits Track B even if built first).

**Final**: `PLATFORM_CONTROL_CENTER_IMPLEMENTATION_REPORT.md`, same format as this
engagement's other final reports — what shipped, what's tested, what's
deliberately deferred, honest score.

## 5. Starting now: Phase 1 — Platform authorization realm

This is the foundation every other phase depends on, and the biggest standing
risk today (a role that grants full cross-tenant access with no MFA enforcement
and no way to grant it except raw SQL). Building:

- Extend `systemRoleEnum` with `super_admin`, `support_admin`, `billing_admin`,
  `platform_viewer` (keep `platform_admin` as-is for backward compat).
- New `PLATFORM_PERMISSIONS` catalog + `roleHasPlatformPermission()` +
  `requirePlatformPermission()` in `src/lib/rbac/guard.ts`, mirroring the existing
  tenant-side pattern exactly.
- A real grant/revoke path: an API route + UI (SUPER_ADMIN-only) to grant/revoke
  platform roles to a user — closing the raw-SQL-only gap.
- Hard MFA requirement enforced at `requirePlatformPermission()`/
  `requirePlatformAdmin()` time for every platform role.
- Tests: permission matrix (allow/deny per role), MFA-not-enabled denial, grant/
  revoke audit trail, no privilege escalation via self-grant.
