import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountingVouchers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess, hasPermission } from "@/lib/rbac/guard";
import { postVoucher, type PostVoucherLine } from "@/lib/accounting/post-voucher";
import { createJournalVoucherSchema, accountingVoucherTypeSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Manual Journal Vouchers — the Phase 1 proof that the posting engine
 * works, entered by a human rather than by any operational flow (nothing
 * in the app calls postVoucher() automatically yet — that's Phase 4). The
 * Opening Balance Voucher has its own dedicated route (opening-balance/)
 * since it needs a plug-account leg the engine computes, not a human.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const typeParam = url.searchParams.get("type");
    const parsedType = typeParam ? accountingVoucherTypeSchema.safeParse(typeParam) : undefined;

    const rows = await db
      .select()
      .from(accountingVouchers)
      .where(
        and(
          eq(accountingVouchers.restaurantId, restaurantId),
          parsedType?.success ? eq(accountingVouchers.voucherType, parsedType.data) : undefined,
        ),
      )
      .orderBy(desc(accountingVouchers.voucherDate), desc(accountingVouchers.createdAt))
      .limit(200);

    return NextResponse.json({ vouchers: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, createJournalVoucherSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    await requireBranchAccess(session.user.id, restaurantId, data.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const lines: PostVoucherLine[] = data.lines.map((line) => ({
      accountId: line.accountId,
      debitInPaisa: line.side === "debit" ? line.amount : undefined,
      creditInPaisa: line.side === "credit" ? line.amount : undefined,
      description: line.description || null,
      customerId: line.customerId ?? null,
      supplierId: line.supplierId ?? null,
    }));

    // A manual journal voucher into an already-closed period needs the
    // higher-trust REOPEN_ACCOUNTING_PERIOD permission on top of
    // MANAGE_ACCOUNTING (checked above) — same trust-escalation shape as
    // CORRECT_CASH_REGISTER. Checked once here (not inside postVoucher,
    // which never does its own RBAC — see that function's own comment) and
    // passed through as a plain flag; postVoucher() only actually consults
    // it if the period turns out to be closed at all.
    const allowClosedPeriod = await hasPermission(
      session.user.id,
      restaurantId,
      PERMISSIONS.REOPEN_ACCOUNTING_PERIOD,
      role,
    );

    const result = await db.transaction((tx) =>
      postVoucher(tx, {
        restaurantId,
        branchId: data.branchId,
        voucherType: "journal",
        voucherDate: data.voucherDate,
        reference: data.reference || null,
        narration: data.narration || null,
        createdByUserId: session.user.id,
        lines,
        allowClosedPeriod,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.voucher_posted",
      resourceType: "accounting_voucher",
      resourceId: result.voucher.id,
      ipAddress: getClientIp(request),
      metadata: { voucherNumber: result.voucher.voucherNumber, voucherType: result.voucher.voucherType },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
