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
