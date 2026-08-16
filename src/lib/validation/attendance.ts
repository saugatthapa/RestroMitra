import { z } from "zod";

export const clockInSchema = z.object({
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

export const clockOutSchema = z.object({
  note: z.string().trim().max(300).optional().or(z.literal("")),
});
