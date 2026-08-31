import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const timeOnly = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");

export const createScheduledShiftSchema = z.object({
  userId: z.string().uuid(),
  branchId: z.string().uuid().nullable().optional(),
  shiftDate: dateOnly,
  startTime: timeOnly,
  endTime: timeOnly,
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

// A shift can be rescheduled (times/date/note) but not reassigned to a
// different staff member — reassignment is a delete-and-recreate, same
// "no reopening/remapping a closed record" pattern this phase's siblings
// (attendance corrections, leave review) also follow, kept simple rather
// than modeling an audit trail for shift reassignment this phase doesn't
// need yet.
export const updateScheduledShiftSchema = z
  .object({
    shiftDate: dateOnly.optional(),
    startTime: timeOnly.optional(),
    endTime: timeOnly.optional(),
    note: z.string().trim().max(300).optional().or(z.literal("")),
  })
  .refine((data) => data.shiftDate !== undefined || data.startTime !== undefined || data.endTime !== undefined || data.note !== undefined, {
    message: "At least one field must be provided.",
  });
