import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderConfigs } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateAiProviderConfigSchema } from "@/lib/validation/ai-provider";
import { upsertProviderConfig, deleteProviderConfig } from "@/lib/ai/provider-config-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Edits or removes one provider config row. PATCH accepts (and requires,
 * for the unique-index upsert underneath) the same `provider` the row was
 * created with — changing which provider a row represents isn't supported;
 * delete and re-create instead, since the ciphertext/model/URL are all
 * provider-specific. `apiKey` omitted or blank leaves the stored key
 * untouched (see updateAiProviderConfigSchema's own comment).
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);
    const { id } = await ctx.params;

    const [existing] = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Provider config not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateAiProviderConfigSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (data.provider !== existing.provider) {
      return NextResponse.json(
        { error: "Can't change which provider a config represents — delete and re-create instead." },
        { status: 400 },
      );
    }

    const config = await upsertProviderConfig(data);

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "ai_provider_config.updated",
      resourceType: "ai_provider_config",
      resourceId: config.id,
      ipAddress: getClientIp(request),
      metadata: {
        provider: config.provider,
        model: config.model,
        isEnabled: config.isEnabled,
        priority: config.priority,
        apiKeyChanged: Boolean(data.apiKey && data.apiKey.trim().length > 0),
      },
    });

    return NextResponse.json({ config });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);
    const { id } = await ctx.params;

    const [existing] = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Provider config not found." }, { status: 404 });
    }

    await deleteProviderConfig(id);

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "ai_provider_config.deleted",
      resourceType: "ai_provider_config",
      resourceId: id,
      ipAddress: getClientIp(request),
      metadata: { provider: existing.provider },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
