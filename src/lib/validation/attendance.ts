import { z } from "zod";

// Phase 12 (Attendance overhaul, Track B) — an object-storage key string,
// never trusted purely by shape (see attendance-photo-key.ts's
// isAttendancePhotoKeyFor, which the clock-in/out routes additionally
// call), but bounded here the same way every other free-text field in
// this schema is.
const photoObjectKeySchema = z.string().trim().min(1).max(500);

// P2 gap-audit fix — workplacePhotoObjectKey is the SEPARATE, always-
// optional workplace/surroundings photo (never the staff member's selfie,
// see schema.ts's clockInWorkplacePhotoObjectKey comment); it goes through
// the exact same object-storage key bounds as photoObjectKey above.
export const clockInSchema = z.object({
  note: z.string().trim().max(300).optional().or(z.literal("")),
  photoObjectKey: photoObjectKeySchema.optional(),
  workplacePhotoObjectKey: photoObjectKeySchema.optional(),
});

export const clockOutSchema = z.object({
  note: z.string().trim().max(300).optional().or(z.literal("")),
  photoObjectKey: photoObjectKeySchema.optional(),
  workplacePhotoObjectKey: photoObjectKeySchema.optional(),
});

// Phase 13 (Attendance overhaul, Track B) — a manual correction to a
// shift's recorded times/note. `reason` is always required (this is the
// "correction-with-reason" contract the implementation plan calls for) —
// everything else is optional, but at least one of clockInAt/clockOutAt/
// note must actually be present (enforced by .refine below), so a
// correction can't be a no-op that still writes an audit/ledger entry.
export const correctAttendanceRecordSchema = z
  .object({
    clockInAt: z.string().datetime().optional(),
    // Explicitly NOT nullable here — reopening a closed shift (clearing
    // clockOutAt back to null) is out of scope for this phase (see
    // attendance-photos-db.ts sibling comments on other deliberately
    // deferred pieces): it would need to interact with
    // attendance_records_one_open_shift_per_user_unique the same way the
    // clock-in route's race handling does, which this simple correction
    // route doesn't attempt. Correcting a WRONG clockOutAt to a different
    // real timestamp, or setting one on a forgotten-to-clock-out shift, is
    // still fully supported — only clearing it back to "still open" isn't.
    clockOutAt: z.string().datetime().optional(),
    note: z.string().trim().max(300).optional().or(z.literal("")),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((data) => data.clockInAt !== undefined || data.clockOutAt !== undefined || data.note !== undefined, {
    message: "At least one of clockInAt, clockOutAt, or note must be provided.",
  });

// Phase 13 — the owner/manager review call on a shift's captured photo(s).
// reviewNote is required when rejecting (a serious claim needs a stated
// reason, same "reason required to enable" pattern as maintenance mode's
// enable path) and optional otherwise.
export const setAttendanceStatusSchema = z
  .object({
    status: z.enum(["needs_review", "verified", "rejected"]),
    reviewNote: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine((data) => data.status !== "rejected" || (data.reviewNote && data.reviewNote.trim().length > 0), {
    message: "A note explaining why is required when rejecting a shift.",
    path: ["reviewNote"],
  });
