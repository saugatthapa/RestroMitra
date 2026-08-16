import { z } from "zod";
import { imageUrlSchema } from "./image";

export const restaurantTypes = [
  "cafe",
  "restaurant",
  "fast_food",
  "momo_shop",
  "bar",
  "hotel_restaurant",
  "bakery",
  "other",
] as const;

export const createRestaurantSchema = z.object({
  name: z.string().trim().min(2, "Restaurant name is required.").max(200),
  type: z.enum(restaurantTypes),
  address: z.string().trim().min(2, "Address is required.").max(500),
  city: z.string().trim().min(1, "City is required.").max(100),
  district: z.string().trim().min(1, "District is required.").max(100),
  phone: z
    .string()
    .trim()
    .regex(/^9[678]\d{8}$/, "Enter a valid 10-digit Nepal mobile number."),
  panVat: z
    .string()
    .trim()
    .max(40)
    .optional()
    .or(z.literal("")),
  openTime: z.string().regex(/^\d{2}:\d{2}$/, "Invalid time."),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/, "Invalid time."),
  logoUrl: imageUrlSchema().optional(),
});

export type CreateRestaurantInput = z.infer<typeof createRestaurantSchema>;
