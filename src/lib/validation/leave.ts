import { z } from "zod";

// Plain "YYYY-MM-DD" — matches the leaveRequests/holidays schema comment:
// these are calendar dates, not instants, so no datetime/timezone parsing
// belongs here.
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const createLeaveRequestSchema = z
  .object({
    leaveType: z.enum(["sick", "casual", "unpaid", "other"]),
    startDate: dateOnly,
    endDate: dateOnly,
    reason: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be on or after the start date.",
    path: ["endDate"],
  });

// Phase 14 — the manager/owner review call on a leave request. Same
// "reviewNote required on the negative call" rule as setAttendanceStatusSchema.
export const reviewLeaveRequestSchema = z
  .object({
    status: z.enum(["approved", "rejected"]),
    reviewNote: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine((data) => data.status !== "rejected" || (data.reviewNote && data.reviewNote.trim().length > 0), {
    message: "A note explaining why is required when rejecting a leave request.",
    path: ["reviewNote"],
  });

export const createHolidaySchema = z.object({
  date: dateOnly,
  name: z.string().trim().min(1).max(200),
  // Omitted or null = applies to every branch; a specific branch id scopes
  // it to just that branch's closure.
  branchId: z.string().uuid().nullable().optional(),
});
