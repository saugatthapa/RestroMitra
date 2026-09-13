import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { hasPermission } from "@/lib/rbac/guard";
import { reverseVoucher } from "@/lib/accounting/post-voucher";
import { reverseVoucherSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Reverses a posted voucher — never edits or deletes it (see
 * post-voucher.ts's own doc comment). Requires a reason, same as
 * correctRegisterShiftSchema's own reason field, for the same audit-trail
 * purpose.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; voucherId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, voucherId } = await ctx.params;
    const { session, restaurantId, role } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNTING,
    );

    const parsed = await parseJsonBody(request, reverseVoucherSchema);
    if (!parsed.ok) return parsed.response;

    const allowClosedPeriod = await hasPermission(
      session.user.id,
      restaurantId,
      PERMISSIONS.REOPEN_ACCOUNTING_PERIOD,
      role,
    );

    const result = await db.transaction((tx) =>
      reverseVoucher(tx, {
        restaurantId,
        voucherId,
        reason: parsed.data.reason,
        reversedByUserId: session.user.id,
        allowClosedPeriod,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.voucher_reversed",
      resourceType: "accounting_voucher",
      resourceId: voucherId,
      ipAddress: getClientIp(request),
      metadata: { reason: parsed.data.reason, reversalVoucherId: result.voucher.id },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
