/**
 * Visit-streak tracking — Phase 18. A "visit" is one calendar day on which
 * a customer has at least one completed order; a second same-day order
 * doesn't count as a second visit (see recordOrderCompletionLoyalty in
 * loyalty.ts, the only caller). The streak continues if the customer's
 * next visit falls within VISIT_STREAK_WINDOW_DAYS of their last one;
 * otherwise it resets to 1. Every VISIT_STREAK_MILESTONE_INTERVAL-th
 * consecutive visit earns a bonus, so the streak is a reward, not just a
 * counter.
 *
 * Deliberately a plain, dependency-free module (no "server-only", no DB
 * import) — same pattern as order-status.ts/kds.ts/loyalty-tiers.ts — so
 * the decision logic is trivially unit-testable and shared unmodified
 * between loyalty.ts's write path and this file's own tests.
 */

/** A visit within this many days of the last one keeps the streak alive. */
export const VISIT_STREAK_WINDOW_DAYS = 7;

/** Every Nth consecutive visit earns a bonus. */
export const VISIT_STREAK_MILESTONE_INTERVAL = 5;

/** Points awarded on a milestone visit (see VISIT_STREAK_MILESTONE_INTERVAL). */
export const VISIT_STREAK_MILESTONE_POINTS = 25;

export type VisitStreakUpdate = {
  currentVisitStreak: number;
  longestVisitStreak: number;
  lastVisitDate: string;
  /** False when this call was a same-day repeat order — nothing changed. */
  isNewVisitDay: boolean;
  milestoneReached: boolean;
};

/** Whole-day difference between two YYYY-MM-DD dates (UTC, DST-proof). */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Pure state transition: given a customer's current streak state and
 * today's date, returns what their new state should be. Called once per
 * completed order that has a linked customer — see
 * recordOrderCompletionLoyalty.
 */
export function computeVisitStreakUpdate(params: {
  lastVisitDate: string | null;
  currentStreak: number;
  longestStreak: number;
  todayIso: string;
}): VisitStreakUpdate {
  const { lastVisitDate, currentStreak, longestStreak, todayIso } = params;

  if (lastVisitDate === todayIso) {
    // A second (or third...) order the same calendar day — already
    // counted as today's visit, don't let repeat orders inflate the streak.
    return {
      currentVisitStreak: currentStreak,
      longestVisitStreak: longestStreak,
      lastVisitDate: todayIso,
      isNewVisitDay: false,
      milestoneReached: false,
    };
  }

  const gapDays = lastVisitDate ? daysBetween(lastVisitDate, todayIso) : null;
  // gapDays < 1 covers both "no prior visit" (null) and clock-skew/backfilled
  // data where today's date is not strictly after the last visit — treated
  // the same as a lapsed streak rather than trusted blindly.
  const continuesStreak = gapDays !== null && gapDays >= 1 && gapDays <= VISIT_STREAK_WINDOW_DAYS;
  const newStreak = continuesStreak ? currentStreak + 1 : 1;
  const newLongest = Math.max(longestStreak, newStreak);

  return {
    currentVisitStreak: newStreak,
    longestVisitStreak: newLongest,
    lastVisitDate: todayIso,
    isNewVisitDay: true,
    milestoneReached: newStreak % VISIT_STREAK_MILESTONE_INTERVAL === 0,
  };
}
