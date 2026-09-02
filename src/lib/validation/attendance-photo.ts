import { z } from "zod";

/** Phase 12 (Attendance overhaul, Track B). */

// P2 gap-audit fix — the two "_workplace" kinds mint a key for the
// separate workplace/surroundings photo (see attendance-photo-key.ts's own
// comment); everything downstream of this schema (the upload-URL route,
// resolveAttendancePhotoForClock) already treats `kind` generically, so no
// other change was needed there to support them.
export const requestPhotoUploadUrlSchema = z.object({
  kind: z.enum(["clock_in", "clock_out", "clock_in_workplace", "clock_out_workplace"]),
});

export const acceptAttendancePhotoConsentSchema = z.object({
  accept: z.literal(true),
});

// P2 gap-audit fix — both fields optional (at least one required) so the
// existing single-field PATCH ({selfieClockInRequired}) keeps working
// unchanged while also allowing the new workplacePhotoRequired toggle to
// be set independently, same "partial update, only touch what's provided"
// shape as the settings route.
export const updateAttendanceSettingsSchema = z
  .object({
    selfieClockInRequired: z.boolean().optional(),
    workplacePhotoRequired: z.boolean().optional(),
  })
  .refine((data) => data.selfieClockInRequired !== undefined || data.workplacePhotoRequired !== undefined, {
    message: "At least one attendance setting must be provided.",
  });
