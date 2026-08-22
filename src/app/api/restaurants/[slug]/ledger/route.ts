import { NextResponse } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { ledgerEntries } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createLedgerEntrySchema } from "@/lib/validation/ledger";
import { recordLedgerEntry } from "@/lib/ledger";
import { LEDGER_CATEGORIES, LEDGER_DIRECTIONS, LEDGER_DUE_STATUSES } from "@/lib/ledger-categories";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const LEDGER_LIST_LIMIT = 500;

/**
 * Lists Account Books entries, gated on MANAGE_ACCOUNT_BOOKS (manager/
 * owner by default — same trust tier as MANAGE_EXPENSES, this is
 * profit-adjacent data). `?from=`/`?to=` (YYYY-MM-DD, inclusive) narrow by
 * entryDate; `?category=`/`?direction=`/`?dueStatus=` narrow further.
 * Voided entries are excluded unless `?includeVoided=true`. For the day/
 * month/year book views themselves, see /ledger/summary — this route is
 * the flat list (also used for the "outstanding dues" tab via
 * ?dueStatus=outstanding, unscoped by date).
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const categoryParam = url.searchParams.get("category");
    const category = (LEDGER_CATEGORIES as readonly string[]).includes(categoryParam ?? "")
      ? (categoryParam as (typeof LEDGER_CATEGORIES)[number])
      : null;
    const directionParam = url.searchParams.get("direction");
    const direction = (LEDGER_DIRECTIONS as readonly string[]).includes(directionParam ?? "")
      ? (directionParam as (typeof LEDGER_DIRECTIONS)[number])
      : null;
    const dueStatusParam = url.searchParams.get("dueStatus");
    const dueStatus = (LEDGER_DUE_STATUSES as readonly string[]).includes(dueStatusParam ?? "")
      ? (dueStatusParam as (typeof LEDGER_DUE_STATUSES)[number])
      : null;
    const includeVoided = url.searchParams.get("includeVoided") === "true";

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          includeVoided ? undefined : eq(ledgerEntries.isVoided, false),
          category ? eq(ledgerEntries.category, category) : undefined,
          direction ? eq(ledgerEntries.direction, direction) : undefined,
          dueStatus ? eq(ledgerEntries.dueStatus, dueStatus) : undefined,
          from ? gte(ledgerEntries.entryDate, from) : undefined,
          to ? lte(ledgerEntries.entryDate, to) : undefined,
        ),
      )
      .orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.createdAt))
      .limit(LEDGER_LIST_LIMIT);

    return NextResponse.json({ entries: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Creates a manual ledger entry — see MANUAL_LEDGER_CATEGORIES for what's allowed here. */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    );

    const parsed = await parseJsonBody(request, createLedgerEntrySchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const entry = await db.transaction((tx) =>
      recordLedgerEntry(tx, {
        restaurantId,
        direction: data.direction,
        category: data.category as (typeof LEDGER_CATEGORIES)[number],
        amountInPaisa: data.amount,
        entryDate: data.entryDate,
        timezone,
        counterpartyName: data.counterpartyName || null,
        description: data.description,
        note: data.note || null,
        markAsDue: data.markAsDue,
        recordedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "ledger.entry_created",
      resourceType: "ledger_entry",
      resourceId: entry.id,
      ipAddress: getClientIp(request),
      metadata: { direction: entry.direction, category: entry.category, amountInPaisa: entry.amountInPaisa },
    });

    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
