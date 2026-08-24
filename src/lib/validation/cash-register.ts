import { z } from "zod";

// Same "optional, verified server-side" pattern as createTableSchema's
// branchId — see that file's own comment.
export const openRegisterShiftSchema = z.object({
  branchId: z.string().uuid().optional(),
  registerName: z.string().trim().min(1).max(60).optional(),
  openingCashInPaisa: z.number().int().min(0).max(100_000_000_00),
  openingNotes: z.string().trim().max(500).optional(),
});

export const closeRegisterShiftSchema = z.object({
  actualCashInPaisa: z.number().int().min(0).max(100_000_000_00),
  closingNotes: z.string().trim().max(500).optional(),
});

export const recordCashMovementSchema = z.object({
  type: z.enum(["addition", "drop", "payout"]),
  amountInPaisa: z.number().int().min(1).max(100_000_000_00),
  reason: z.string().trim().max(300).optional(),
});

export const correctRegisterShiftSchema = z.object({
  newActualCashInPaisa: z.number().int().min(0).max(100_000_000_00),
  reason: z.string().trim().min(1, "A reason is required.").max(300),
});
