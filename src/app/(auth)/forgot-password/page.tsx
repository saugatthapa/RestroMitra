"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api-client";
import { AuthField } from "@/components/auth/AuthField";
import { AuthIcon } from "@/components/auth/AuthIcons";

export default function ForgotPasswordPage() {
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiPost("/api/auth/forgot-password", { phone });
      // Always show the same success state, regardless of what actually
      // happened server-side — see that route's own doc comment on why a
      // reset-request response must never vary by outcome.
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send a reset link right now.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
      <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Enter the phone number on your account and we&apos;ll email you a link to reset your
        password, if you have an email on file.
      </p>

      {sent ? (
        <div className="mt-6 space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-green-500/15 px-3 py-2.5 text-sm text-green-300">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              <AuthIcon.Check />
            </span>
            If that phone number has an account with an email on file, we&apos;ve sent a password
            reset link to it. The link works once and expires in 30 minutes.
          </p>
          <p className="text-xs text-ink-faint">
            No email on file, or nothing arrives? Ask your restaurant owner to reset it for you
            from the Staff page.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <AuthField label="Phone number" icon={<AuthIcon.Phone />}>
            <input
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="input"
              placeholder="98XXXXXXXX"
              inputMode="numeric"
              autoComplete="tel"
              maxLength={10}
              autoFocus
            />
          </AuthField>

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                <AuthIcon.ShieldCheck />
              </span>
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-medium text-orange-400 hover:text-orange-300">
          ← Back to sign in
        </Link>
      </p>
    </div>
  );
}
