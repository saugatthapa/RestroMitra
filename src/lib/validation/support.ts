import { z } from "zod";
import { SUPPORT_TAGS } from "@/lib/support/tags";

/** Platform Control Center (Phase 9) — adding an internal support note to a tenant. */
export const addSupportNoteSchema = z.object({
  note: z.string().trim().min(1, "Enter a note.").max(2000),
});

/** Attaching one of the fixed catalog tags (see support/tags.ts) to a tenant. */
export const addSupportTagSchema = z.object({
  tag: z.enum(SUPPORT_TAGS),
});

/** Gap audit P1 — a tenant filing a new support ticket: subject + opening message together. */
export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(1, "Enter a subject.").max(200),
  body: z.string().trim().min(1, "Enter a message.").max(4000),
  priority: z.enum(["low", "normal", "high"]).optional(),
});

/** A reply on an existing ticket's thread — used by both the tenant and admin routes. */
export const addSupportTicketMessageSchema = z.object({
  body: z.string().trim().min(1, "Enter a message.").max(4000),
});

/** Admin-only ticket status transition. */
export const updateSupportTicketStatusSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]),
});
