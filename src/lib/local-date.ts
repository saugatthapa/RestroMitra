/**
 * "What day is it right now, on THIS device" — for client components only.
 * Deliberately the mirror image of src/lib/restaurant-date.ts's server-side
 * restaurantDate(): a browser-rendered "today" default (an Account Books
 * anchor date, a Reservations day picker, an Expenses form's default date,
 * ...) should reflect the staff member's own device clock, which is already
 * correct local time — no restaurant timezone lookup needed or wanted here.
 *
 * `.toISOString().slice(0, 10)` (UTC) is the bug this replaces: a device in
 * Nepal (UTC+5:45) calling that between local midnight and 5:45am would get
 * YESTERDAY's date, not today's. Reading the local Date parts directly
 * (getFullYear/getMonth/getDate) uses the browser's own timezone instead.
 *
 * No "server-only" import — this runs in the browser.
 */
export function localDateIso(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * QA hardening (P2 backlog): the first calendar day of `date`'s month, on
 * THIS DEVICE's clock — same local-timezone reasoning as localDateIso
 * above, just anchored to day 1 instead of today. Extracted here because
 * ReportsBoard.tsx and StaffBoard.tsx had each hand-rolled an identical
 * copy of this exact function (same getFullYear/getMonth/padStart logic)
 * as a default "This month" / payroll-period-start anchor — cosmetic
 * duplication, not a bug, but a shared home means the next such default
 * doesn't need a third copy.
 */
export function firstOfMonthIso(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}
