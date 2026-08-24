import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const closeDailyBusinessSchema = z.object({
  branchId: z.string().uuid().optional(),
  businessDate: isoDate,
  notes: z.string().trim().max(500).optional(),
});
