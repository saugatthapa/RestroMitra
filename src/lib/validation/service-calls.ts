import { z } from "zod";

export const updateServiceCallSchema = z.object({
  action: z.enum(["acknowledge", "resolve"]),
});
