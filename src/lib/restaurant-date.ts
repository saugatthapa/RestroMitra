/**
 * Timezone-aware "what day/time is it for this restaurant" helpers.
 *
 * Nearly every "today" computation in this app used to be
 * `new Date().toISOString().slice(0, 10)` — UTC's calendar day, not the
 * restaurant's. Nepal is UTC+5:45, and the app server doesn't run on
 * Nepal time, so anything computed between midnight and ~6:15am Nepal
 * time was silently misclassified as the PREVIOUS day everywhere this
 * ran: reservations, payroll payment dates, expense defaults, the ledger
 * summary's default date, the AI assistant, reports, account books,
 * customer birthdays, order numbering, KOT tickets, loyalty.
 * restaurants.timezone has existed since Phase 1 specifically to make
 * this correct — it just was never threaded through to any of these call
 * sites (see the long-standing comment this replaces in reports.ts).
 *
 * Deliberately dependency-free (no date-fns-tz/luxon) — Intl.DateTimeFormat
 * with a `timeZone` option is enough to derive a wall-clock Y-M-D/H:M:S
 * for any IANA zone using only what Node's built-in ICU data already
 * provides, same "plain module, zero new deps" pattern as
 * ledger-categories.ts / expense-categories.ts.
 */
import "server-only";

/** Matches restaurants.timezone's own column default in schema.ts. */
const DEFAULT_TIMEZONE = "Asia/Kathmandu";

function safeTimeZone(timezone: string | null | undefined): string {
  return timezone && timezone.trim() ? timezone : DEFAULT_TIMEZONE;
}

function formatPartsMap(timezone: string, at: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23", // 00-23, never the "24" some ICU builds emit for hour12:false at midnight
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

/**
 * This timezone's UTC offset, in minutes, at the instant `at` occurs
 * (handles DST automatically for any zone that observes it — Nepal
 * doesn't, but this stays correct if the product ever expands beyond it).
 * Standard trick: format `at` as wall-clock time IN the target zone,
 * re-interpret those same digits as if they were UTC, and diff against
 * the real UTC instant — the difference is exactly the offset.
 */
function offsetMinutes(timezone: string, at: Date): number {
  const p = formatPartsMap(timezone, at);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return (asUtc - at.getTime()) / 60_000;
}

/** YYYY-MM-DD for `at` (default: now) as seen on `timezone`'s wall clock. */
export function restaurantDate(timezone: string | null | undefined, at: Date = new Date()): string {
  const p = formatPartsMap(safeTimeZone(timezone), at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** HH (00-23) for `at` (default: now) as seen on `timezone`'s wall clock —
 * for peak-hours-style analytics buckets. */
export function restaurantHour(timezone: string | null | undefined, at: Date = new Date()): number {
  const p = formatPartsMap(safeTimeZone(timezone), at);
  return Number(p.hour);
}

/**
 * The UTC instant corresponding to local midnight, in `timezone`, on
 * `dateStr` (YYYY-MM-DD; default: today in that timezone). This is the
 * inverse of restaurantDate() — turning a local calendar date back into
 * an absolute instant, for querying/bucketing timestamp columns by
 * "restaurant day" rather than UTC day.
 */
export function restaurantStartOfDay(timezone: string | null | undefined, dateStr?: string): Date {
  const tz = safeTimeZone(timezone);
  const ymd = dateStr ?? restaurantDate(tz);
  const [y, m, d] = ymd.split("-").map(Number);
  // First guess: treat the local date as if it were already UTC midnight,
  // then correct by that instant's actual offset in this timezone. One
  // correction pass is enough for any real-world IANA zone (offsets don't
  // change fast enough within a single day for this to need iterating).
  const guessUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = offsetMinutes(tz, new Date(guessUtc));
  return new Date(guessUtc - offset * 60_000);
}

/** The last millisecond of the local day on `dateStr` (default: today) in `timezone`. */
export function restaurantEndOfDay(timezone: string | null | undefined, dateStr?: string): Date {
  const start = restaurantStartOfDay(timezone, dateStr);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}
