# RestroMitra Privacy Policy

**Last updated:** August 31, 2026

## Read this first

This document is **not legal advice**, and it is **not a substitute for a qualified lawyer's review before commercial launch**. It is a plain, honest description of what RestroMitra — the software, as it exists in this codebase today — actually collects, stores, and does with personal data. Nothing here should be read as a claim of compliance with any specific jurisdiction's data-protection law (including Nepal's Individual Privacy Act, 2075 (2018), which is referenced below only because it is the law most directly relevant to where this product currently operates, not because a lawyer has confirmed the product satisfies it).

If you are a restaurant owner using RestroMitra to run your business, you are a "data controller" for your customers' and staff's personal data under most privacy frameworks, and RestroMitra is your "data processor." You are responsible for having your own lawful basis to collect that data and for telling your own customers and staff about it — this policy describes what the software does; it does not replace your own obligations to the people whose data you put into it.

## Who this covers

This policy applies to personal data processed by the RestroMitra platform: the software used by restaurant owners, managers, and staff to run point-of-sale, ordering, staff, inventory, and accounting operations, and by their customers when interacting with a restaurant's QR ordering, loyalty, or reservation features.

## What data we collect, and why

### 1. Restaurant owners, managers, and staff accounts

When someone signs up for or is added to a restaurant on RestroMitra, we collect:

- **Full name and phone number** (required — phone number is the account's unique login identifier)
- **Email address** (optional, used for password reset and notifications where configured)
- **Password** — stored only as a one-way hash, never in plain text or reversibly encrypted
- **Role and permissions** at each restaurant/branch (owner, manager, cashier, kitchen staff, waiter, etc.)
- **Login/session metadata** — session tokens, last-login timestamp

This is collected to operate the account and to enforce role-based access control (so a cashier, for example, cannot see payroll data a manager can).

If two-factor authentication (TOTP) is enabled, a TOTP secret and backup codes are stored to verify login codes. The TOTP secret is stored in a readable (not one-way-hashed) form, because verifying a live 6-digit code against it requires reading it back — the same trust boundary the rest of this system assumes (anyone with direct database access already has access to restaurant data; see "Who can see this data" below).

### 2. Staff employment and payroll data

For staff who are paid through the platform, a restaurant's managers/owners can additionally record:

- **Salary configuration** — pay type (monthly/daily/hourly), amount, and usual payment method
- **Bank account details** (bank name, account number, account holder name) — only if the restaurant chooses to record them, for record-keeping; RestroMitra does not initiate or process bank transfers
- **Payroll payment history** — each pay run, amount, method, and any manually-entered deduction/addition lines
- **Attendance records** — clock-in/clock-out timestamps, scheduled shifts, leave requests, and holiday assignments

This data exists to let a restaurant run payroll and track attendance; RestroMitra does not use it for any purpose beyond making it available to that restaurant's own authorized managers/owners.

### 3. Staff attendance photos ("selfie verification")

A restaurant can optionally turn on photo-verified clock-in/clock-out. When it is on:

- **One photo is captured** at each clock-in and clock-out, from the staff member's own device camera
- **Consent is required before the first photo is captured** — the staff member is shown a notice (see `src/lib/attendance-consent.ts`) explaining what is collected, why, who can see it, and how long it is kept, and must actively agree before any photo is taken. Every version of that notice a staff member has ever agreed to is kept as a permanent record (an append-only consent ledger), never overwritten.
- **Photos are stored in private object storage** (an S3-compatible bucket — AWS S3, Cloudflare R2, Backblaze B2, or self-hosted MinIO, depending on deployment), never in the application database and never in a publicly-reachable location. The application only ever holds a storage *key*, not the image itself.
- **Access to a photo is only ever through a short-lived, cryptographically signed URL** minted fresh at the moment someone with permission views it. No permanent or long-lived public link to a photo exists anywhere in the system.
- **Who can see a photo**: that restaurant's own owner/managers (the same people who can already see clock-in/out times), and RestroMitra platform staff for support or legal purposes if genuinely needed. Platform administrators have no dedicated screen for browsing staff photos — access, if ever needed, would be through direct infrastructure access, not a built-in admin feature.
- **Retention**: photos are automatically deleted after a configurable retention period, currently defaulting to **90 days** from the clock-in date (`ATTENDANCE_PHOTO_RETENTION_DAYS`, an environment variable an operator can shorten or lengthen per deployment; 90 days is the shipped default, not a legally mandated number). Deletion is performed by a purge routine (`src/lib/attendance-photos-db.ts`) that removes the file from storage and clears the corresponding database columns. **This purge is not run on an automatic schedule by the application itself** — this codebase has no background job runner — so it only runs when a platform administrator (or an external cron job configured by the operator) triggers the `/api/admin/system/purge-attendance-photos` endpoint. In a deployment where nobody has wired up that trigger, expired photos will not, in practice, be deleted on time. This is a real operational gap, described honestly rather than glossed over — see `DATA_RETENTION.md`.
- A staff member can decline consent and still clock in/out without a photo, unless their specific restaurant has made a photo mandatory, in which case declining means using self-service clock-in/out is unavailable to them at that restaurant (they can still be clocked in/out manually by a manager).

### 4. Customers

A restaurant's customers may have the following collected, depending on which features that restaurant uses (QR ordering, loyalty program, reservations, customer credit):

- **Phone number and full name** (required to identify a customer record)
- **Email address and date of birth** (optional — date of birth is used only to compute a birthday-bonus loyalty date; only month and day are read for that purpose, not age)
- **Order history** — items ordered, amounts spent, order dates, linked to that customer's profile for loyalty/CRM purposes
- **Loyalty points balance and tier**, visit streak history
- **Notes** a restaurant's staff choose to add to a customer's profile
- **Outstanding credit balance**, if a restaurant extends store credit to that customer

This data is collected by the restaurant operating RestroMitra, for its own CRM, loyalty, and billing purposes. RestroMitra does not sell, rent, or share customer data across restaurants, and each restaurant's customer list is isolated from every other restaurant's on the platform.

### 5. Financial records

Every restaurant's expenses, purchases, supplier records, ledger/"Account Books" entries, cash-register sessions, and end-of-day closes are stored to give that restaurant its own financial record-keeping. These records are restaurant-owned business data (see `TERMS.md`) and are visible only to that restaurant's own authorized staff, scoped by role/permission.

### 6. AI assistant usage

If a restaurant uses the AI assistant feature, its questions and the data pulled to answer them (e.g. "what sold best last week") are sent to a configured third-party AI provider to generate a response, scoped strictly to that restaurant's own data — never mixed with another restaurant's. If a restaurant configures its own AI provider API key, that key is stored encrypted at rest (`api_key_ciphertext` — see `src/lib/ai/encryption.ts`), not in plain text.

## How data is stored and protected

- Every restaurant's data is isolated from every other restaurant's at the application layer — every request resolves which restaurant it belongs to server-side, never trusting a client-supplied restaurant ID.
- Passwords are one-way hashed, never stored or logged in plain text.
- Attendance selfies live in private object storage, accessed only via short-lived signed URLs — never a public bucket, never embedded directly in application pages.
- AI provider API keys are encrypted at rest.
- TOTP (two-factor) secrets are stored in a readable form because the login-verification check requires it — this is a deliberate, disclosed exception, not an oversight; anyone with direct production database access already has access to every restaurant's business data in this design, the same trust boundary a small self-hosted or single-tenant-database system generally assumes.
- Sensitive actions (payroll changes, refunds, staff management, platform-admin actions) are recorded in an audit log for accountability.
- Security headers, session controls (logout-everywhere on password reset/change), and role-based access control are enforced server-side throughout the application.

RestroMitra has not undergone an independent third-party security audit or penetration test as of this writing. Deployment security (server hardening, database access control, backup encryption) depends on how a given operator deploys it — this document describes the application's own behavior, not any specific hosting environment's guarantees.

## Data retention and deletion

See `DATA_RETENTION.md` for the full per-category breakdown. In short:

- Attendance photos: retained for a configurable period (90 days by default), then purged — but only when the purge routine is actually run (see above).
- Everything else (accounts, orders, payroll, ledger, customer records) is kept indefinitely by default, for as long as a restaurant's account exists, because a restaurant's own financial and business records generally need to persist for its own operational and (in most jurisdictions) statutory record-keeping purposes.
- **There is currently no self-service "delete my account and all data" feature** anywhere in the product, for either a restaurant owner, a staff member, or a customer. Removing data today requires a direct request handled by whoever operates the platform (see "How to request deletion or export" below), not a button in the app. This is a real, current limitation, not a design choice being defended — see `DATA_RETENTION.md`.
- Cancelling or letting a subscription lapse does **not** delete a restaurant's data. It is a deliberately non-destructive state: a restaurant that stops paying keeps its data intact and can regain full access by renewing, rather than risking accidental data loss from a billing lapse.

## How to request deletion or export

Because there is no automated self-service flow today, a request to access, correct, export, or delete personal data should be sent directly to whoever operates your RestroMitra instance:

- If you are a restaurant's customer or staff member, ask that restaurant's owner/manager first — they control your data on the platform and can action most requests (e.g. correcting a phone number, deleting a specific attendance photo) directly from their dashboard.
- If you are a restaurant owner, or your restaurant's manager cannot resolve the request, contact **privacy@restromitra.com** (a placeholder contact address — replace this with a real, monitored inbox before commercial launch).

Some data export already exists as a self-service feature inside the product for restaurant owners/managers: customer lists, inventory, ledger/Account Books, supplier records, and the staff roster can each be exported today. Orders, purchases, attendance, and payroll do not yet have a dedicated export feature — a manual data pull would currently be needed for those.

## Children's data

RestroMitra is a business tool for restaurant operations, not intended for use by children, and does not knowingly collect data about children beyond what a restaurant might record about its own staff (who are assumed to be of legal working age under applicable local law — the software does not itself verify staff age).

## Changes to this policy

This document will be updated as the product's actual data practices change. Because it is meant to describe reality, not aspirations, any material change in what data the product collects or how long it is kept should come with an update here in the same commit/release.

## Contact

**privacy@restromitra.com** (placeholder — set a real, monitored address before commercial launch).

---

*This policy was written by reading the actual application source code as of this date, not assumed from a template. If the product's behavior changes, this document should be updated in the same change — an inaccurate privacy policy is worse than none. Before commercial launch, have this reviewed by a lawyer qualified to advise on data protection obligations in every jurisdiction where RestroMitra will actually operate.*
