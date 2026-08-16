import { z } from "zod";
import { PLAN_KEYS } from "@/lib/plans";

/** An owner requesting a plan from their /billing page — logs intent only, doesn't activate anything. */
export const upgradeRequestSchema = z.object({
  planKey: z.enum(PLAN_KEYS),
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
  z.object({
    action: z.literal("assign_plan"),
    planKey: z.enum(PLAN_KEYS),
    activate: z.boolean(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("mark_past_due"),
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
