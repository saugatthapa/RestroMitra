"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api-client";
import { AuthTabs } from "@/components/auth/AuthTabs";
import { AuthField } from "@/components/auth/AuthField";
import { AuthIcon } from "@/components/auth/AuthIcons";
import { PasswordField } from "@/components/auth/PasswordField";

// Same Nepal mobile number shape the server validates against
// (src/lib/validation/auth.ts) — mirrored here only for instant client-side
// feedback as the person types; the server remains the actual source of
// truth and re-validates on submit regardless.
const NEPAL_PHONE_REGEX = /^9[678]\d{8}$/;

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const phoneValid = NEPAL_PHONE_REGEX.test(phone.trim());
  const passwordsMatch = confirmPassword.length === 0 || confirmPassword === password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (confirmPassword !== password) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      await apiPost("/api/auth/register", { fullName, phone, email, password });
      router.push("/onboarding");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create account.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <AuthTabs />

      <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-ink">Create your account</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Start your 30-day free trial. No card required.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <AuthField label="Full name" icon={<AuthIcon.User />}>
            <input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input"
              placeholder="Sita Rai"
              autoComplete="name"
            />
          </AuthField>

          <AuthField
            label="Phone number"
            icon={<AuthIcon.Phone />}
            status={
              phoneTouched && phone.length > 0
                ? phoneValid
                  ? { tone: "success", message: "Looks good." }
                  : { tone: "error", message: "Enter a valid 10-digit Nepal mobile number." }
                : null
            }
          >
            <input
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setPhoneTouched(true)}
              className={`input ${
                phoneTouched && phone.length > 0 && !phoneValid
                  ? "border-red-400 focus:border-red-500 focus:ring-red-100"
                  : ""
              }`}
              placeholder="98XXXXXXXX"
              inputMode="numeric"
              autoComplete="tel"
              maxLength={10}
            />
          </AuthField>

          <AuthField label="Email (optional)" icon={<AuthIcon.Mail />}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </AuthField>

          <PasswordField
            label="Password"
            value={password}
            onChange={setPassword}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            showStrength
          />

          <div>
            <AuthField
              label="Confirm password"
              icon={<AuthIcon.Lock />}
              status={
                !passwordsMatch ? { tone: "error", message: "Passwords don't match." } : null
              }
            >
              <input
                required
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`input ${!passwordsMatch ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
                placeholder="Re-enter your password"
                autoComplete="new-password"
              />
            </AuthField>
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                <AuthIcon.ShieldCheck />
              </span>
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? "Creating account…" : "Start free trial"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-ink-muted">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-orange-400 hover:text-orange-300">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
