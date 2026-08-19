import { z } from "zod";

export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required.").max(100),
});

export const updateExpenseCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });
