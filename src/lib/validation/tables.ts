import { z } from "zod";
import { TABLE_STATUSES } from "@/lib/table-status";

export const createTableSchema = z.object({
  // Optional: when omitted, the route defaults to the caller's own branch
  // if their grant is branch-scoped, otherwise the restaurant's main
  // branch (Phase 11a). If sent explicitly, it's still verified
  // server-side to both belong to this restaurant AND be one the caller
  // has access to (requireBranchAccess) — never trusted at face value.
  branchId: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Table name is required.").max(50),
  capacity: z.number().int().min(1).max(100).optional(),
  floorLabel: z.string().trim().max(50).optional(),
});

// Floor-plan layout fields — Phase 12. Bounded to a reasonable canvas so a
// stray client-side value can't produce an unusably huge/negative table.
export const updateTableSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  capacity: z.number().int().min(1).max(100).nullable().optional(),
  isActive: z.boolean().optional(),
  posX: z.number().int().min(0).max(10000).nullable().optional(),
  posY: z.number().int().min(0).max(10000).nullable().optional(),
  width: z.number().int().min(40).max(600).optional(),
  height: z.number().int().min(40).max(600).optional(),
  shape: z.enum(["rectangle", "circle", "square"]).optional(),
  rotation: z.number().int().min(0).max(359).optional(),
  floorLabel: z.string().trim().max(50).nullable().optional(),
});

export const updateTableStatusSchema = z.object({
  status: z.enum(TABLE_STATUSES),
});
