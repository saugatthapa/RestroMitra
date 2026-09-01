# RestroMitra Data Retention & Deletion

**Last updated:** August 31, 2026

## Read this first

This document is **not legal advice**. It describes what RestroMitra's code actually does with data retention and deletion today — verified against the source, not assumed — so anyone relying on it knows exactly what to expect, including where the honest answer is "this isn't built yet." **Have this reviewed by a lawyer before commercial launch**, particularly if a specific jurisdiction's law requires a maximum retention period this document doesn't yet enforce.

## Summary: what's actually automated vs. manual today

| Category | Retention today | Deletion mechanism |
|---|---|---|
| Attendance selfie photos | 90 days by default (configurable) | Automated purge routine, but **not scheduled** — must be triggered by an operator |
| Accounts / sessions | Indefinite while active | Manual only (no self-service account deletion) |
| Customer records | Indefinite while restaurant is active | Manual only |
| Financial records (payroll, expenses, ledger) | Indefinite | Manual only |
| Restaurant data after subscription lapse/cancellation | Retained indefinitely, unchanged | Not deleted automatically at all |

## Attendance photos

- **Retention period**: `ATTENDANCE_PHOTO_RETENTION_DAYS` if an operator sets it (must be a positive integer), otherwise a **90-day default** (`DEFAULT_RETENTION_DAYS` in `src/lib/attendance-photos-db.ts`). This is the same number disclosed to staff in the consent notice they must agree to before their first photo is taken (`src/lib/attendance-consent.ts`).
- **How the purge works**: `purgeExpiredAttendancePhotos()` finds every attendance record whose clock-in happened more than the retention window ago and still has a stored photo key, deletes the actual file from object storage, and clears the database columns pointing to it. It is idempotent (safe to re-run) and records an audit log entry (`attendance.photos_purged`) per record purged. A storage-delete failure for one record doesn't block the rest of the batch — it's retried on the next run.
- **This is not run automatically by the application.** RestroMitra has no background job scheduler. The purge only runs when a platform administrator (or an external cron/scheduled task an operator has wired up) calls `POST /api/admin/system/purge-attendance-photos`. **If nobody has set up that external trigger for a given deployment, expired photos are not actually deleted on schedule** — they sit past their disclosed retention window until someone runs the purge manually. This is a real gap between the disclosed policy and guaranteed enforcement, stated plainly here rather than glossed over. Closing it (wiring an actual scheduled cron to that endpoint in production) should happen before treating the 90-day figure as a hard guarantee to staff or regulators.
- A staff member can ask their employer to delete a specific photo before its retention window expires; that would currently be done as a manual database/storage action by whoever operates the platform, since there is no in-app "delete this one photo" button today.

## Accounts, sessions, and login data

- User accounts, sessions, and role assignments are kept for as long as the account is active. Deactivating a staff member's access (removing their role) does not delete their user account or their historical attendance/order/audit records — it revokes access going forward, which is the correct behavior for preserving an accurate historical record (e.g., past payroll payments, past order actions) rather than a bug.
- Password reset tokens are single-use and expire; expired/used tokens are not actively purged from the database on a schedule, but they carry no ongoing access risk once expired or used.
- Sessions can be individually or collectively revoked (password reset revokes all sessions; password change revokes all *other* sessions; a "log out everywhere else" action exists) — this is access revocation, not data deletion.

## Customer records

Customer profiles (name, phone, order history, loyalty balance, notes) are retained indefinitely by default, for as long as the restaurant that collected them remains on the platform. There is no automatic time-based expiry or anonymization of customer records today. A restaurant's own staff can edit or deactivate (`isActive: false`) a customer record from the CRM; there is no dedicated "erase this customer's data" action distinct from that today.

## Financial and business records (payroll, expenses, ledger/Account Books, purchases, suppliers)

These are retained indefinitely by default. This is intentional, not an oversight — financial and payroll records typically need to persist for a restaurant's own operational history and (in most jurisdictions) for some statutory record-keeping period, and RestroMitra does not attempt to guess or enforce a specific jurisdiction's minimum/maximum retention rule for these. A restaurant that wants to purge old records today would need to do so manually (there is no bulk "delete records older than X" tool in the product).

## What happens when a subscription lapses or is cancelled

This is the same non-destructive behavior described in `TERMS.md` §3, restated here from the retention/deletion angle:

- A lapsed trial, a `past_due`, `paused`, `cancelled`, or `expired` subscription status blocks working access to the application (per `computeSubscriptionAccess()` in `src/lib/subscription.ts`) but **does not trigger any deletion of the restaurant's data**. No code path in this application deletes a restaurant's orders, customers, staff records, financial records, or attendance data as a consequence of a subscription state change.
- A restaurant's data remains intact and fully restorable by reactivating/renewing.
- This means there is currently no defined "hard delete after N months of non-payment" policy — a restaurant's data can sit indefinitely in a blocked-access state. Whether that's the right long-term policy (vs. eventually deleting genuinely abandoned tenants' data after a defined, disclosed period) is a business/legal decision this document does not make on its own — it only describes today's actual (non-)behavior.

## What happens if a restaurant asks to close its account entirely

**There is currently no self-service "delete my account and all data" flow anywhere in the product** — not for a restaurant owner, not for an individual staff member, not for a customer. This is a genuine, current limitation of the product, stated here plainly rather than described as a future roadmap item disguised as already-solved. Today, a full account/data deletion request would have to be:

1. Sent to whoever operates the RestroMitra deployment (see the contact address in `PRIVACY.md`), and
2. Actioned manually against the database and object storage by that operator — there is no built-in admin tool that performs a full, verified per-restaurant data purge today.

Before commercial launch, and especially before RestroMitra makes any specific promise (in `PRIVACY.md`, in a signed customer contract, or to a regulator) about honoring deletion requests within a specific timeframe, this gap should be closed with a real, tested deletion tool — or the promised timeframe should account for the fact that, today, it is a manual process.

## Data export

Some categories already have a working export today (self-service, from the restaurant's own dashboard): customer lists, inventory, ledger/Account Books entries, supplier records, and the staff roster. Orders, purchases, attendance records, and payroll do not have a dedicated export tool yet — obtaining those today requires a manual data pull by whoever operates the platform.

## Backups

A backup/restore process exists and has been tested against a real, populated database (`pg_dump`/`pg_restore`), but it runs as a manual command today, not on an automated schedule. This means backup recency depends on how often an operator actually remembers to run it in a given deployment — this document does not assert any specific recovery-point-objective (RPO) because none is currently enforced by automation.

## Summary of honest gaps to close before making stronger promises

1. **The attendance-photo purge is not on an automatic schedule** — wire it to a real cron before treating "90 days" as a guarantee.
2. **No self-service account/data deletion exists** for any role — build one, or be explicit in any external promise that deletion requests are currently handled manually and may take longer than a fully automated flow would.
3. **No automated backup schedule** — the process is tested and correct, but recency depends on manual discipline today.
4. **No defined end-state for data belonging to a restaurant whose subscription has lapsed indefinitely** — worth a deliberate business decision, not left implicit.

---

*This document was written by reading the actual retention/purge code (`src/lib/attendance-photos-db.ts`, `src/lib/attendance-consent.ts`, `src/lib/subscription.ts`) and the platform-admin purge route, not assumed from a template. It should be re-verified against the code any time retention or deletion behavior changes. Before commercial launch, have this reviewed by a lawyer to confirm it meets the retention/deletion obligations of every jurisdiction RestroMitra actually operates in.*
