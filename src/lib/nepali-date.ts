import NepaliDate from "nepali-date-converter";
import type { DateSystem } from "./date-system";

/**
 * AD/BS (Bikram Sambat) date formatting, shared by every screen the
 * dashboard header's calendar toggle (DateSystemProvider) governs. Backed
 * by `nepali-date-converter` (MIT, zero runtime deps) rather than a
 * hand-rolled conversion table — BS month lengths vary year to year (it's a
 * lunar-solar calendar), so this isn't something worth approximating
 * in-house when a small, well-maintained library gets it right.
 */

/** e.g. "31 Shrawan 2083" — the BS equivalent of the given (or today's) date. */
export function formatBsDate(date: Date = new Date()): string {
  return new NepaliDate(date).format("DD MMMM YYYY");
}

/** e.g. "16 Aug 2026" — Gregorian, formatted to match the BS string's shape. */
export function formatAdDate(date: Date = new Date()): string {
  return date.toLocaleDateString("en-NP", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The single formatter every record-displaying screen should call instead
 * of `toLocaleDateString`/`toLocaleString` directly — pass it the current
 * `dateSystem` from `useDateSystem()` and it renders in whichever calendar
 * the user has toggled, so flipping the header switch once changes every
 * order, reservation, expense, and ledger entry on screen at the same time
 * rather than just the header's own label.
 *
 * Accepts a Date, an ISO/date-only string, or null/undefined (renders as
 * "—") since that's the shape most API responses hand back for optional
 * date fields. Dates are parsed and displayed in the browser's local time
 * zone, same as the `toLocaleString` calls this replaces.
 */
export function formatDate(
  value: Date | string | null | undefined,
  system: DateSystem,
  opts: { withTime?: boolean } = {},
): string {
  if (value == null || value === "") return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  if (system === "BS") {
    const datePart = new NepaliDate(date).format("DD MMM YYYY");
    if (!opts.withTime) return datePart;
    const timePart = date.toLocaleTimeString("en-NP", { hour: "numeric", minute: "2-digit" });
    return `${datePart}, ${timePart}`;
  }

  if (!opts.withTime) {
    return date.toLocaleDateString("en-NP", { day: "numeric", month: "short", year: "numeric" });
  }
  return date.toLocaleString("en-NP", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Just the time-of-day part, in whichever system is active. BS and AD tell
 * the same clock time — the calendar only changes how the *date* reads —
 * so this exists purely so callers that only show a time (reservation
 * slots, clock-in/out) don't need to think about which system they're in.
 */
export function formatTimeOfDay(value: Date | string | null | undefined): string {
  if (value == null || value === "") return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-NP", { hour: "numeric", minute: "2-digit" });
}

/**
 * A short "≈ 31 Shrawan 2083" hint to place next to a native
 * `<input type="date">`. Native date inputs are Gregorian-only (no browser
 * ships a BS picker), so rather than rebuilding every date filter as a
 * custom BS calendar widget, inputs stay Gregorian for entry/filtering and
 * this hint shows the BS equivalent alongside them when BS is the active
 * system — the "months and dates" the user sees are still in BS, even
 * though the click-to-pick widget itself is a native Gregorian one.
 */
export function formatBsHint(isoDateOnly: string): string {
  if (!isoDateOnly) return "";
  const date = new Date(`${isoDateOnly}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return `≈ ${new NepaliDate(date).format("DD MMMM YYYY")}`;
}

/** "Shrawan 2083" — the BS month/year label for a Gregorian YYYY-MM-DD anchor date. */
export function formatBsMonthYear(isoDateOnly: string): string {
  if (!isoDateOnly) return "";
  const date = new Date(`${isoDateOnly}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return new NepaliDate(date).format("MMMM YYYY");
}

/** Just the BS year (e.g. "2083") that a Gregorian YYYY-MM-DD date falls in. */
export function formatBsYear(isoDateOnly: string): string {
  if (!isoDateOnly) return "";
  const date = new Date(`${isoDateOnly}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return new NepaliDate(date).format("YYYY");
}
