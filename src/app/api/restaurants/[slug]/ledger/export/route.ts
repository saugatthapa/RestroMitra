import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listLedgerEntries } from "@/lib/ledger";
import { LEDGER_CATEGORIES, LEDGER_CATEGORY_LABELS, LEDGER_DIRECTIONS, LEDGER_DIRECTION_LABELS, LEDGER_DUE_STATUSES } from "@/lib/ledger-categories";
import { paisaToRupees } from "@/lib/money";
import { toCsv } from "@/lib/csv";

// A higher ceiling than the UI's own 500-row page (LEDGER_LIST_LIMIT in
// ../route.ts) — an export is explicitly "give me everything for this
// range", not a paginated view, but still bounded so one request can't
// pull an unbounded table.
const EXPORT_ROW_LIMIT = 20_000;

/**
 * Commercial Launch Phase B.5 — Data Export. CSV export of Account Books
 * (ledger) entries, gated on the SAME permission as viewing them
 * (MANAGE_ACCOUNT_BOOKS) — no new EXPORT_DATA permission is introduced (see
 * the master spec's "reuse, don't invent" principle): a generic export
 * permission would risk letting a caller export data they can't otherwise
 * view. Filters mirror GET /ledger exactly, just reusing listLedgerEntries
 * (see ledger.ts) at a higher row limit.
 *
 * Gap audit (P1) — `requireOwnerMfa: true` additionally requires MFA to be
 * enabled when the CALLER is the owner (a no-op for a manager/accountant
 * running the same export — see requireOwnerMfaEnabled's own doc comment
 * in guard.ts). A bulk CSV of every financial ledger entry is exactly the
 * kind of exfiltratable financial data this audit targets.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS, {
      requireOwnerMfa: true,
    });

    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const categoryParam = url.searchParams.get("category");
    const category = (LEDGER_CATEGORIES as readonly string[]).includes(categoryParam ?? "")
      ? (categoryParam as (typeof LEDGER_CATEGORIES)[number])
      : undefined;
    const directionParam = url.searchParams.get("direction");
    const direction = (LEDGER_DIRECTIONS as readonly string[]).includes(directionParam ?? "")
      ? (directionParam as (typeof LEDGER_DIRECTIONS)[number])
      : undefined;
    const dueStatusParam = url.searchParams.get("dueStatus");
    const dueStatus = (LEDGER_DUE_STATUSES as readonly string[]).includes(dueStatusParam ?? "")
      ? (dueStatusParam as (typeof LEDGER_DUE_STATUSES)[number])
      : undefined;
    const includeVoided = url.searchParams.get("includeVoided") === "true";

    const rows = await listLedgerEntries(
      restaurantId,
      { from: from ?? undefined, to: to ?? undefined, category, direction, dueStatus, includeVoided },
      EXPORT_ROW_LIMIT,
    );

    const csv = toCsv(rows, [
      { header: "Date", value: (r) => r.entryDate },
      { header: "Direction", value: (r) => LEDGER_DIRECTION_LABELS[r.direction] },
      { header: "Category", value: (r) => LEDGER_CATEGORY_LABELS[r.category] },
      { header: "Description", value: (r) => r.description },
      { header: "Counterparty", value: (r) => r.counterpartyName ?? "" },
      { header: "Amount (Rs)", value: (r) => paisaToRupees(r.amountInPaisa) },
      { header: "Due status", value: (r) => r.dueStatus },
      { header: "Settled amount (Rs)", value: (r) => paisaToRupees(r.settledAmountInPaisa) },
      { header: "Note", value: (r) => r.note ?? "" },
      { header: "Voided", value: (r) => r.isVoided },
      { header: "Recorded at", value: (r) => r.createdAt.toISOString() },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="account-books-${from ?? "all"}-to-${to ?? "all"}.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
