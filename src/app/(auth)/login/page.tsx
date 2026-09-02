"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api-client";
import { safeInternalRedirect } from "@/lib/safe-redirect";
import { AuthTabs } from "@/components/auth/AuthTabs";
import { AuthField } from "@/components/auth/AuthField";
import { AuthIcon } from "@/components/auth/AuthIcons";
import { PasswordField } from "@/components/auth/PasswordField";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

type LoginResponse = { ok: true } | { mfaRequired: true; challengeToken: string };

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Commercial Launch Phase B.4 — MFA. A successful password check on an
  // account with MFA enabled comes back as { mfaRequired: true,
  // challengeToken } rather than logging in outright (see
  // api/auth/login/route.ts's own comment) — this form just switches to a
  // second step in place, holding the challenge token in memory only,
  // rather than navigating to a separate page.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [mfaCode, setMfaCode] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiPost<LoginResponse>("/api/auth/login", { phone, password });
      if ("mfaRequired" in res && res.mfaRequired) {
        setChallengeToken(res.challengeToken);
        return;
      }
      const next = safeInternalRedirect(searchParams.get("next"));
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log in.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitMfa(e: FormEvent) {
    e.preventDefault();
    if (!challengeToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiPost("/api/auth/mfa/verify", {
        challengeToken,
        ...(useBackupCode ? { backupCode: mfaCode } : { code: mfaCode }),
      });
      const next = safeInternalRedirect(searchParams.get("next"));
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify that code.");
    } finally {
      setSubmitting(false);
    }
  }

  if (challengeToken) {
    return (
      <div>
        <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-ink">Two-factor verification</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {useBackupCode
              ? "Enter one of your backup codes."
              : "Enter the 6-digit code from your authenticator app."}
          </p>

          <form onSubmit={onSubmitMfa} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-secondary">
                {useBackupCode ? "Backup code" : "6-digit code"}
              </span>
              <input
                required
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                className="input"
                inputMode={useBackupCode ? "text" : "numeric"}
                maxLength={useBackupCode ? 12 : 6}
                autoFocus
              />
            </label>

            {error && (
              <p className="flex items-start gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  <AuthIcon.ShieldCheck />
                </span>
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {submitting ? "Verifying…" : "Verify"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-muted">
            <button
              type="button"
              onClick={() => {
                setUseBackupCode((v) => !v);
                setMfaCode("");
                setError(null);
              }}
              className="font-medium text-orange-400 hover:text-orange-300"
            >
              {useBackupCode ? "Use my authenticator app instead" : "Use a backup code instead"}
            </button>
          </p>
          <p className="mt-2 text-center text-sm text-ink-muted">
            <button
              type="button"
              onClick={() => {
                setChallengeToken(null);
                setMfaCode("");
                setError(null);
              }}
              className="text-ink-faint hover:text-ink-secondary"
            >
              ← Back to sign in
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AuthTabs />

      <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-ink">Welcome back</h1>
        <p className="mt-1 text-sm text-ink-muted">Log in to your restaurant dashboard.</p>

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
            />
          </AuthField>

          <div>
            <PasswordField
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
            <div className="mt-1.5 text-right">
              <Link href="/forgot-password" className="text-xs font-medium text-orange-400 hover:text-orange-300">
                Forgot password?
              </Link>
            </div>
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
            {submitting ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-ink-muted">
          New to RestroKendra?{" "}
          <Link href="/register" className="font-medium text-orange-400 hover:text-orange-300">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
