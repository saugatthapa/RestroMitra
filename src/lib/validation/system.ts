import { z } from "zod";
import { ANNOUNCEMENT_SEVERITIES } from "@/lib/system/announcements";

const optionalDate = z
  .string()
  .datetime()
  .optional()
  .transform((v) => (v ? new Date(v) : null));

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(200),
  body: z.string().trim().min(1, "Enter a message.").max(2000),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES as [string, ...string[]]),
  startsAt: optionalDate,
  endsAt: optionalDate,
});

export const setAnnouncementActiveSchema = z.object({
  isActive: z.boolean(),
});

export const setMaintenanceModeSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    message: z.string().trim().max(500).optional(),
    reason: z.string().trim().min(3, "Enter a reason.").max(500),
  }),
  z.object({
    enabled: z.literal(false),
  }),
]);

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .optional()
  .or(z.literal(""))
  .refine((v) => !v || /^https?:\/\//i.test(v), "Enter a full https:// link.");

/**
 * The admin-editable contact details shown on /verify-account — see
 * verification-contact-db.ts's own comment. whatsappNumber deliberately
 * has no strict format check (unlike onboarding's Nepal-only phone regex):
 * an admin should be able to paste whatever number actually works,
 * including one already in international format — whatsapp.ts's
 * whatsappLink() only special-cases the bare-10-digit-Nepal-number shape,
 * anything else passes through as typed.
 */
export const updateVerificationContactSchema = z.object({
  instagramUrl: optionalUrl,
  tiktokUrl: optionalUrl,
  whatsappNumber: z.string().trim().max(32).optional().or(z.literal("")),
  message: z.string().trim().min(1, "Enter a message.").max(1000),
});
