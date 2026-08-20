import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { sendTestPush } from "@/lib/push";
import { hasValidCsrfHeader } from "@/lib/request";

/**
 * Self-diagnostic for Web Push — see sendTestPush's own doc comment for why
 * this exists (an owner deploying VAPID for the first time otherwise has no
 * way to tell "not configured," "not subscribed," and "actually broken"
 * apart without reading server logs they may not have access to). Any
 * signed-in staff member can test their OWN device; there's nothing here
 * that touches another user's data, so no permission beyond being logged
 * into this restaurant is required.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session } = await resolveRestaurantContext(slug);

    const outcome = await sendTestPush(session.user.id);
    return NextResponse.json(outcome);
  } catch (err) {
    return toErrorResponse(err);
  }
}
