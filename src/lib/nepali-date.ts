import NepaliDate from "nepali-date-converter";

/**
 * AD/BS (Bikram Sambat) date formatting for the dashboard header's calendar
 * toggle. Backed by `nepali-date-converter` (MIT, zero runtime deps) rather
 * than a hand-rolled conversion table — BS month lengths vary year to year
 * (it's a lunar-solar calendar), so this isn't something worth
 * approximating in-house when a small, well-maintained library gets it
 * right.
 */

/** e.g. "31 Shrawan 2083" — the BS equivalent of the given (or today's) date. */
export function formatBsDate(date: Date = new Date()): string {
  return new NepaliDate(date).format("DD MMMM YYYY");
}

/** e.g. "16 Aug 2026" — Gregorian, formatted to match the BS string's shape. */
export function formatAdDate(date: Date = new Date()): string {
  return date.toLocaleDateString("en-NP", { day: "numeric", month: "short", year: "numeric" });
}
