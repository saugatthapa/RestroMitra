import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { settleLedgerDueSchema } from "@/lib/validation/ledger";
import { settleLedgerDue } from "@/lib/ledger";
import { db } from "@/db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Settles all or part of an outstanding due — see settleLedgerDue's own
 * comment (ledger.ts) for the partial-settlement/compare-and-swap shape.
 * A 409 here means someone else settled this exact entry a moment ago;
 * the client should refresh and re-check the remaining balance.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; entryId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, entryId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    );

    const parsed = await parseJsonBody(request, settleLedgerDueSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction((tx) =>
      settleLedgerDue(tx, {
        restaurantId,
        entryId,
        amountInPaisa: data.amount,
        note: data.note || null,
        recordedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "ledger.due_settled",
      resourceType: "ledger_entry",
      resourceId: entryId,
      ipAddress: getClientIp(request),
      metadata: { amountInPaisa: data.amount },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
