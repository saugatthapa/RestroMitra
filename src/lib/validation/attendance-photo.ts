import { z } from "zod";

/** Phase 12 (Attendance overhaul, Track B). */

export const requestPhotoUploadUrlSchema = z.object({
  kind: z.enum(["clock_in", "clock_out"]),
});

export const acceptAttendancePhotoConsentSchema = z.object({
  accept: z.literal(true),
});

export const updateAttendanceSettingsSchema = z.object({
  selfieClockInRequired: z.boolean(),
});
