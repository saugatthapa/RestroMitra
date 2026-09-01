import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getAtRiskTenants } from "@/lib/support/health-score-db";
import type { HealthBand } from "@/lib/support/health-score";

const VALID_BANDS: HealthBand[] = ["healthy", "watch", "at_risk"];

/**
 * Gap-audit P1 fix (Finding 3) — proactive platform alerting: "these N
 * tenants are at risk," aggregated platform-wide from the same
 * computeHealthScore() rubric the restaurant detail page already uses
 * per-tenant (src/lib/support/health-score.ts), rather than a second,
 * differently-tuned scoring system. `?band=` widens the cutoff — default
 * `at_risk` only; pass `watch` to also include the (less urgent) watch
 * band.
 *
 * Gated MANAGE_SUPPORT — same permission the restaurant detail page's own
 * health score panel already requires (see SupportPanel/the restaurant
 * detail route's own comment on why health data is support-team-facing),
 * so this list is visible to exactly the same audience that could already
 * see any one tenant's score, just aggregated.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);

    const url = new URL(request.url);
    const bandParam = url.searchParams.get("band");
    const maxBand: HealthBand = VALID_BANDS.includes(bandParam as HealthBand)
      ? (bandParam as HealthBand)
      : "at_risk";

    const tenants = await getAtRiskTenants(maxBand);
    return NextResponse.json({ tenants, band: maxBand });
  } catch (err) {
    return toErrorResponse(err);
  }
}
