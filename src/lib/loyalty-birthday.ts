/**
 * Birthday bonus — Phase 18. A one-time-per-year point credit awarded the
 * first time anything in the restaurant touches a customer's record on
 * their birthday: a completed order (recordOrderCompletionLoyalty), or a
 * plain CRM/POS lookup (the "self-healing on read" reconciliation in the
 * customers GET routes — see reconcileBirthdayBonus in loyalty.ts, and
 * subscription-db.ts's reconcileSubscriptionStatus for the pattern this
 * follows: no cron job, this app has no infrastructure for one).
 *
 * Deliberately a plain, dependency-free module (no "server-only", no DB
 * import) — same pattern as loyalty-streaks.ts/loyalty-tiers.ts — so the
 * decision logic is trivially unit-testable and shared unmodified between
 * every call site.
 */

export const BIRTHDAY_BONUS_POINTS = 100;

/**
 * True when `todayIso` falls on the same month+day as `dateOfBirth` — the
 * birth YEAR never matters for "is today their birthday". Both are
 * YYYY-MM-DD strings (the `date` column's string mode), so this is a plain
 * substring compare, no date-library parsing needed.
 */
export function isBirthdayToday(dateOfBirth: string | null, todayIso: string): boolean {
  if (!dateOfBirth) return false;
  return dateOfBirth.slice(5) === todayIso.slice(5);
}

/**
 * True when today is the customer's birthday AND they haven't already
 * received this year's bonus. `lastBirthdayBonusYear` is the guard against
 * double-award — from two completed orders the same birthday, or a
 * completed order followed by a CRM lookup later the same day.
 */
export function shouldAwardBirthdayBonus(params: {
  dateOfBirth: string | null;
  lastBirthdayBonusYear: number | null;
  todayIso: string;
}): boolean {
  if (!isBirthdayToday(params.dateOfBirth, params.todayIso)) return false;
  const currentYear = Number(params.todayIso.slice(0, 4));
  return params.lastBirthdayBonusYear !== currentYear;
}
