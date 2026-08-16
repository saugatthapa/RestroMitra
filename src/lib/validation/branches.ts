import { z } from "zod";

export const createBranchSchema = z.object({
  name: z.string().trim().min(2, "Branch name is required.").max(150),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
});

export const updateBranchSchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    address: z.string().trim().max(300).optional().or(z.literal("")),
    city: z.string().trim().max(100).optional().or(z.literal("")),
    phone: z.string().trim().max(20).optional().or(z.literal("")),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });
