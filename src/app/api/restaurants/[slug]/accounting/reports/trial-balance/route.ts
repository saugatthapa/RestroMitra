import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getTrialBalance } from "@/lib/accounting/financial-statements";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 3 — Trial Balance as of a date (or since inception if `asOfDate` is
 * omitted). Column totals should always match by construction (postVoucher
 * refuses anything that doesn't balance) — `isBalanced` is reported anyway
 * so the UI can flag it plainly if that ever turns out false.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const asOfDateParam = url.searchParams.get("asOfDate");
    const parsed = asOfDateParam ? reportDateSchema.safeParse(asOfDateParam) : undefined;

    const trialBalance = await getTrialBalance({
      restaurantId,
      asOfDate: parsed?.success ? parsed.data : undefined,
    });

    return NextResponse.json(trialBalance);
  } catch (err) {
    return toErrorResponse(err);
  }
}
