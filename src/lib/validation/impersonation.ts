import { z } from "zod";

/**
 * Platform Control Center (Phase 8) — starting an impersonation session.
 * `reason` is mandatory and non-blank (spec item 8: "a support agent must
 * never be able to impersonate silently") — the min(3) mirrors this
 * project's existing convention for a mandatory-reason field (see
 * adminTenantSuspensionSchema in validation/subscription.ts). `mode`
 * defaults to "read_only" — write access is an opt-in escalation, never
 * the default, and is further gated at the route layer by whether the
 * admin actually holds IMPERSONATE_TENANT_WRITE (a Zod schema can validate
 * shape, not permissions).
 */
export const startImpersonationSchema = z.object({
  restaurantId: z.string().uuid("Invalid restaurant."),
  reason: z.string().trim().min(3, "Enter a reason.").max(500),
  mode: z.enum(["read_only", "write"]).default("read_only"),
});

export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;

/** The platform dashboard's "Revoke" control — force-ending ANOTHER admin's active session. */
export const revokeImpersonationSchema = z.object({
  sessionId: z.string().uuid("Invalid session."),
});
