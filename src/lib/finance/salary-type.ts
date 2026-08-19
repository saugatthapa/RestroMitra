/**
 * Phase 22 — how a staff member's salary is measured. Dependency-free,
 * same "plain shared catalog" pattern as expense-payment-methods.ts —
 * imported unmodified by validation, the payroll API routes, and the
 * staff/payroll dashboard UI.
 */

export const SALARY_TYPES = ["monthly", "daily", "hourly"] as const;
export type SalaryType = (typeof SALARY_TYPES)[number];

export const SALARY_TYPE_LABELS: Record<SalaryType, string> = {
  monthly: "Monthly",
  daily: "Daily",
  hourly: "Hourly",
};
