import { describe, it, expect } from "vitest";
import {
  computeVisitStreakUpdate,
  VISIT_STREAK_WINDOW_DAYS,
  VISIT_STREAK_MILESTONE_INTERVAL,
} from "./loyalty-streaks";

describe("computeVisitStreakUpdate", () => {
  it("starts a new streak at 1 for a customer's first-ever visit", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: null,
      currentStreak: 0,
      longestStreak: 0,
      todayIso: "2026-08-16",
    });
    expect(result).toEqual({
      currentVisitStreak: 1,
      longestVisitStreak: 1,
      lastVisitDate: "2026-08-16",
      isNewVisitDay: true,
      milestoneReached: false,
    });
  });

  it("does not change anything for a second order the same day", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-16",
      currentStreak: 3,
      longestStreak: 5,
      todayIso: "2026-08-16",
    });
    expect(result).toEqual({
      currentVisitStreak: 3,
      longestVisitStreak: 5,
      lastVisitDate: "2026-08-16",
      isNewVisitDay: false,
      milestoneReached: false,
    });
  });

  it("continues the streak when the gap is 1 day", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-15",
      currentStreak: 3,
      longestStreak: 3,
      todayIso: "2026-08-16",
    });
    expect(result.currentVisitStreak).toBe(4);
    expect(result.longestVisitStreak).toBe(4);
    expect(result.isNewVisitDay).toBe(true);
  });

  it(`continues the streak at exactly the ${VISIT_STREAK_WINDOW_DAYS}-day window boundary`, () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-09",
      currentStreak: 2,
      longestStreak: 2,
      todayIso: "2026-08-16", // exactly 7 days later
    });
    expect(result.currentVisitStreak).toBe(3);
  });

  it("resets the streak to 1 once the gap exceeds the window", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-08",
      currentStreak: 6,
      longestStreak: 6,
      todayIso: "2026-08-16", // 8 days later
    });
    expect(result.currentVisitStreak).toBe(1);
    expect(result.longestVisitStreak).toBe(6); // longest is a high-water mark, never drops
  });

  it("treats a today-before-lastVisitDate anomaly as a lapsed streak, not negative growth", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-16",
      currentStreak: 4,
      longestStreak: 4,
      todayIso: "2026-08-10",
    });
    // lastVisitDate === todayIso only matches exact equality; an earlier
    // "today" than the stored last-visit date is backfilled/skewed data —
    // gapDays comes out negative, which correctly fails the `>= 1` check.
    expect(result.currentVisitStreak).toBe(1);
  });

  it(`reaches a milestone every ${VISIT_STREAK_MILESTONE_INTERVAL}th consecutive visit`, () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-15",
      currentStreak: 4,
      longestStreak: 4,
      todayIso: "2026-08-16",
    });
    expect(result.currentVisitStreak).toBe(5);
    expect(result.milestoneReached).toBe(true);
  });

  it("does not reach a milestone on a non-multiple visit", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-15",
      currentStreak: 3,
      longestStreak: 4,
      todayIso: "2026-08-16",
    });
    expect(result.currentVisitStreak).toBe(4);
    expect(result.milestoneReached).toBe(false);
  });

  it("never reaches a milestone on a same-day repeat order, even at a multiple", () => {
    const result = computeVisitStreakUpdate({
      lastVisitDate: "2026-08-16",
      currentStreak: 5,
      longestStreak: 5,
      todayIso: "2026-08-16",
    });
    expect(result.milestoneReached).toBe(false);
  });
});
