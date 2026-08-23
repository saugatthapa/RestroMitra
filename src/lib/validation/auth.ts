import { z } from "zod";

// Nepal mobile numbers: 10 digits, commonly starting 9. Kept permissive
// (98/97/96 prefixes cover current carriers) but this should be revisited
// against current NTC/telecom numbering rules before commercial launch.
const nepalPhoneRegex = /^9[678]\d{8}$/;

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(200),
  phone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .optional()
    .or(z.literal("")),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export const loginSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
  password: z.string().min(1, "Password is required."),
});

// RC audit P1 fix — self-service change-password (previously there was no
// way for a logged-in user to change their own password at all, only
// register/login).
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
