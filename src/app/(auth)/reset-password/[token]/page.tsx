"use client";

import { use, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiPost, ApiError } from "@/lib/api-client";
import { PasswordField } from "@/components/auth/PasswordField";
import { AuthIcon } from "@/components/auth/AuthIcons";

export default function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await apiPost("/api/auth/reset-password", { token, newPassword });
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset your password.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
        <p className="flex items-start gap-2 rounded-lg bg-green-500/15 px-3 py-2.5 text-sm text-green-300">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            <AuthIcon.Check />
          </span>
          Your password has been reset. Taking you to sign in…
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
      <h1 className="text-lg font-semibold text-ink">Choose a new password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        You&apos;ll be logged out everywhere and can sign in fresh with your new password.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <PasswordField
          label="New password"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          showStrength
        />
        <PasswordField
          label="Confirm new password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
        />
        {mismatch && <p className="text-xs text-red-400">Passwords don&apos;t match.</p>}

        {error && (
          <p className="flex items-start gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              <AuthIcon.ShieldCheck />
            </span>
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Resetting…" : "Reset password"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-medium text-orange-400 hover:text-orange-300">
          ← Back to sign in
        </Link>
      </p>
    </div>
  );
}
