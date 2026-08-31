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
