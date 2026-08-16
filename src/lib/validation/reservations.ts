import { z } from "zod";
import { RESERVATION_STATUSES } from "@/lib/reservation-status";

// Nepal mobile numbers: 10 digits, commonly starting 9. Same pattern/regex
// as auth.ts/staff.ts/customers.ts — kept in sync deliberately.
const nepalPhoneRegex = /^9[678]\d{8}$/;

export const createReservationSchema = z.object({
  // Optional link to an existing CRM customer (Phase 8b) — verified
  // server-side to belong to this restaurant, same "resolve, don't trust"
  // pattern used for tableId/customerId elsewhere. customerName/Phone are
  // always required directly, even when a customerId is given, so the
  // reservation is fully readable without a join.
  customerId: z.string().uuid().nullable().optional(),
  customerName: z.string().trim().min(2, "Enter a name for the booking.").max(150),
  customerPhone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
  partySize: z.number().int().min(1, "Party size must be at least 1.").max(100),
  tableId: z.string().uuid().nullable().optional(),
  // Phase 11a: only consulted when tableId is omitted — when a table is
  // given, its own branch always wins (a reservation can't be for a table
  // in a different branch than the reservation itself).
  branchId: z.string().uuid().nullable().optional(),
  // ISO 8601 datetime string (e.g. from a <input type="datetime-local">
  // converted to an ISO string client-side) — validated and coerced to a
  // real Date here so an unparseable value is rejected up front rather
  // than silently becoming "Invalid Date" at the DB layer.
  reservationTime: z.coerce.date({ error: "Enter a valid date and time." }),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateReservationSchema = z
  .object({
    customerName: z.string().trim().min(2).max(150).optional(),
    customerPhone: z.string().trim().regex(nepalPhoneRegex).optional(),
    partySize: z.number().int().min(1).max(100).optional(),
    tableId: z.string().uuid().nullable().optional(),
    reservationTime: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });

export const updateReservationStatusSchema = z.object({
  status: z.enum(RESERVATION_STATUSES),
});
