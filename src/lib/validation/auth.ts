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

// Commercial Launch Phase B.3 — Forgot Password. Identified by phone, same
// as login, since phone (not email) is this app's actual login identifier
// and every account has one (email is optional at registration).
export const forgotPasswordSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Missing or invalid reset link."),
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});

// Commercial Launch Phase B.4 — MFA login-time verification. Exactly one
// of `code` (a live 6-digit TOTP code) or `backupCode` (one of the
// one-time recovery codes issued at enrollment) must be present — never
// both, never neither.
export const mfaVerifySchema = z
  .object({
    challengeToken: z.string().min(1, "Missing or invalid login session."),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.")
      .optional(),
    backupCode: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.code) !== Boolean(data.backupCode), {
    message: "Provide either a 6-digit code or a backup code, not both.",
  });

export const mfaEnrollConfirmSchema = z.object({
  secret: z.string().min(1, "Missing enrollment secret."),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});

export const mfaDisableSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;
export type MfaEnrollConfirmInput = z.infer<typeof mfaEnrollConfirmSchema>;
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;
