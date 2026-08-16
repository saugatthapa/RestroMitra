"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api-client";
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

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiPost("/api/auth/login", { phone, password });
      const next = searchParams.get("next") ?? "/dashboard";
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <AuthTabs />

      <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-neutral-900">Welcome back</h1>
        <p className="mt-1 text-sm text-neutral-500">Log in to your restaurant dashboard.</p>

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

          <PasswordField
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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

        <p className="mt-6 text-center text-sm text-neutral-500">
          New to DhankiPOS?{" "}
          <Link href="/register" className="font-medium text-orange-600 hover:text-orange-700">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
