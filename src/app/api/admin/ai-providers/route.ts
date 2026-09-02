import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderConfigs } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createAiProviderConfigSchema } from "@/lib/validation/ai-provider";
import { getAllProviderConfigsForAdmin, upsertProviderConfig } from "@/lib/ai/provider-config-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 7) — provider config management. Gated
 * MANAGE_AI_PROVIDERS for both read and write, same "full-access-tier only"
 * shape as feature-flags (no narrower default role holds it — see
 * platform-permissions.ts). GET responses are always the redacted
 * AiProviderConfigSummary shape (hasApiKey boolean, never the key or its
 * ciphertext) — see provider-config-db.ts's rowToSummary.
 */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);

    // QA hardening (P2 backlog): platform-admin list/read endpoints had no
    // rate limiting of their own — lower severity since they require an
    // already-authenticated, MFA'd platform-admin session, but still a
    // defense-in-depth backstop. Shares the `admin-read:user` bucket with
    // every other admin list/read route, same "one abuse surface" pattern
    // as menu-write:user.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const configs = await getAllProviderConfigsForAdmin();
    return NextResponse.json({ configs });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);

    const parsed = await parseJsonBody(request, createAiProviderConfigSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const existing = await db
      .select({ id: aiProviderConfigs.id })
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.provider, data.provider))
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        { error: `${data.provider} is already configured — edit the existing entry instead.` },
        { status: 409 },
      );
    }

    const config = await upsertProviderConfig(data);

    // Deliberately never logging the API key itself, even in metadata —
    // see aiProviderConfigs' own schema comment on apiKeyCiphertext.
    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "ai_provider_config.created",
      resourceType: "ai_provider_config",
      resourceId: config.id,
      ipAddress: getClientIp(request),
      metadata: { provider: config.provider, model: config.model, isEnabled: config.isEnabled, priority: config.priority },
    });

    return NextResponse.json({ config }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
