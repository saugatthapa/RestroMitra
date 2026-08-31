import { z } from "zod";

// Phase 12 (Attendance overhaul, Track B) — an object-storage key string,
// never trusted purely by shape (see attendance-photo-key.ts's
// isAttendancePhotoKeyFor, which the clock-in/out routes additionally
// call), but bounded here the same way every other free-text field in
// this schema is.
const photoObjectKeySchema = z.string().trim().min(1).max(500);

export const clockInSchema = z.object({
  note: z.string().trim().max(300).optional().or(z.literal("")),
  photoObjectKey: photoObjectKeySchema.optional(),
});

export const clockOutSchema = z.object({
  note: z.string().trim().max(300).optional().or(z.literal("")),
  photoObjectKey: photoObjectKeySchema.optional(),
});
