/**
 * Phase 12 (Attendance overhaul, Track B) — the notice-and-consent text
 * for selfie capture at clock-in/out. Deliberately a plain, dependency-free
 * module (no "server-only", no DB import), same pattern as attendance.ts —
 * shared unmodified between the API routes that check/record consent and
 * the staff-facing consent dialog UI.
 *
 * Nepal's Individual Privacy Act, 2075 (2018) conditions lawful collection
 * of personal information — biometric data named explicitly — on the data
 * subject's informed consent plus notice of the collection's purpose. The
 * Act itself does not prescribe a specific retention period or a formal
 * consent mechanism (no implementing regulations had been issued as of
 * this feature's build); ATTENDANCE_PHOTO_RETENTION_DAYS below is this
 * product's own operational choice, not a legally mandated number. This
 * notice is written to be honest about what the product actually does,
 * not to constitute legal advice — a restaurant with specific compliance
 * obligations should have its own counsel review this text.
 *
 * CURRENT_CONSENT_VERSION is bumped whenever NOTICE_TEXT changes in any
 * way a reasonable person would want re-notified about. A version bump
 * does NOT retroactively invalidate anyone's prior consent record (the
 * ledger in attendance_photo_consents keeps every version ever agreed to)
 * — it just means hasCurrentConsent() below starts requiring a fresh
 * consent from that point on.
 */

export const CURRENT_CONSENT_VERSION = "2026-08-v1";

export const CONSENT_NOTICE_TITLE = "Selfie verification for clock-in/out";

export const CONSENT_NOTICE_TEXT = `This restaurant has turned on selfie-verified attendance. Before your \
first clock-in or clock-out, we need your consent to take and store a photo of you at that moment.

What we collect: one photo each time you clock in and clock out, taken from your device's camera at \
that moment.

Why: to verify attendance records are genuine — the same purpose your clock-in/out timestamps already \
serve.

Who can see it: your restaurant's owner and managers (the same people who can already see your \
clock-in/out times), and RestroKendra platform staff for support or legal purposes. Never shared outside \
that.

How long it's kept: retained for a limited period and then automatically deleted (ask your owner/manager \
for this restaurant's specific retention period). You can ask your employer to delete a specific photo at \
any time.

You can decline. If you don't consent, you can still clock in and out without a photo — unless your \
employer has made a photo required for this restaurant, in which case declining means you won't be able \
to use self-service clock-in/out here and should talk to your manager.`;

export type ConsentRecord = {
  consentVersion: string;
};

/** True when the given (most recent) consent record covers today's notice text. */
export function hasCurrentConsent(record: ConsentRecord | null | undefined): boolean {
  return record?.consentVersion === CURRENT_CONSENT_VERSION;
}
