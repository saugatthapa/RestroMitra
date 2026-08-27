import { z } from "zod";

// Phase 4 — plan keys are no longer a fixed literal union (a platform admin
// can add a new one from /admin/plans without a code change), so this is a
// shape-only check. "Does this key actually exist / is it active" is a DB
// question, validated at the route layer via getPlanByKey (see
// src/lib/plans-db.ts) — never here.
const planKeySchema = z.string().trim().min(1).max(40);

/** An owner requesting a plan from their /billing page — logs intent only, doesn't activate anything. */
export const upgradeRequestSchema = z.object({
  planKey: planKeySchema,
  note: z.string().trim().max(500).optional(),
});

/**
 * The platform-admin subscription action endpoint. A discriminated union
 * rather than one bag-of-optional-fields schema, so each action can only
 * be sent with the fields it actually needs — e.g. "cancel" can't
 * accidentally carry a stray planKey that looks like it did something.
 */
export const adminSubscriptionActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("extend_trial"),
    days: z.number().int().min(1, "Must extend by at least 1 day.").max(365, "365 days max."),
    note: z.string().trim().max(500).optional(),
  }),
  // Phase 3 — trial management's other half of "extend/shorten". Floors at
  // "now" rather than allowing a negative remaining time — shortening a
  // trial to its harshest is ending it immediately, not backdating it into
  // the past, which read-paths like daysRemaining() already treat as 0
  // without needing to special-case a negative value.
  z.object({
    action: z.literal("shorten_trial"),
    days: z.number().int().min(1, "Must shorten by at least 1 day.").max(365, "365 days max."),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("assign_plan"),
    planKey: planKeySchema,
    activate: z.boolean(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("mark_past_due"),
    note: z.string().trim().max(500).optional(),
  }),
  // Phase 3 — reversible pause (see schema.ts's subscriptionStatusEnum
  // comment for how this differs in intent from "cancel", despite sharing
  // its access-blocked math).
  z.object({
    action: z.literal("pause"),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("cancel"),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("reactivate"),
    note: z.string().trim().max(500).optional(),
  }),
]);

export type AdminSubscriptionAction = z.infer<typeof adminSubscriptionActionSchema>;

/**
 * Platform Control Center (Phase 2) — deliberately a separate schema/route
 * from the subscription action above: suspension is an ops/policy
 * decision, not a billing state, and always needs a stated reason (a
 * subscription action's `note` is optional; this isn't).
 */
export const adminTenantSuspensionSchema = z.object({
  action: z.enum(["suspend", "reactivate"]),
  reason: z.string().trim().min(3, "Enter a reason.").max(500),
});
