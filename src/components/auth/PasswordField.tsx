"use client";

import { useState } from "react";
import { AuthField } from "./AuthField";
import { AuthIcon } from "./AuthIcons";

/**
 * Score a password against the exact same rule the server enforces
 * (validatePasswordStrength in src/lib/auth/password.ts: 8+ chars, letters
 * AND numbers) plus a couple of extra tiers for a more useful meter —
 * "Meets requirements" is the real pass/fail line, everything past it is
 * just encouragement toward a stronger password, not a stricter gate.
 */
function scorePassword(password: string): { tier: 0 | 1 | 2 | 3; label: string } {
  if (password.length === 0) return { tier: 0, label: "" };
  const meetsBase = password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
  if (!meetsBase) return { tier: 0, label: "Too weak — needs 8+ characters with letters and numbers" };

  let bonus = 0;
  if (password.length >= 12) bonus++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) bonus++;
  if (/[^a-zA-Z0-9]/.test(password)) bonus++;

  if (bonus >= 2) return { tier: 3, label: "Strong password" };
  if (bonus === 1) return { tier: 2, label: "Good password" };
  return { tier: 1, label: "Meets requirements — could be stronger" };
}

const TIER_COLOR = ["bg-surface-3", "bg-red-400", "bg-amber-400", "bg-green-500"];

export function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  showStrength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: string;
  showStrength?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const { tier, label: strengthLabel } = showStrength
    ? scorePassword(value)
    : { tier: 0 as const, label: "" };

  return (
    <div>
      <AuthField
        label={label}
        icon={<AuthIcon.Lock />}
        trailing={
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            className="rounded-md p-1.5 text-ink-faint hover:bg-surface-1 hover:text-ink-secondary"
          >
            {visible ? <AuthIcon.EyeOff /> : <AuthIcon.Eye />}
          </button>
        }
      >
        <input
          required
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input"
          placeholder={placeholder}
          autoComplete={autoComplete}
        />
      </AuthField>
      {showStrength && value.length > 0 && (
        <div className="mt-1.5">
          <div className="flex gap-1">
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  step <= tier ? TIER_COLOR[tier] : "bg-surface-3"
                }`}
              />
            ))}
          </div>
          <p
            className={`mt-1 text-xs ${
              tier === 0 ? "text-red-400" : tier === 1 ? "text-amber-400" : "text-green-400"
            }`}
          >
            {strengthLabel}
          </p>
        </div>
      )}
    </div>
  );
}
