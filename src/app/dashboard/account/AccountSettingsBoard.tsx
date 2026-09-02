"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

export function AccountSettingsBoard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null);

  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setChangeError(null);
    setChangeSuccess(null);

    if (newPassword !== confirmPassword) {
      setChangeError("New password and confirmation don't match.");
      return;
    }

    setChanging(true);
    try {
      const res = await apiPost<{ ok: true; otherSessionsRevoked: number }>(
        "/api/auth/change-password",
        { currentPassword, newPassword },
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setChangeSuccess(
        res.otherSessionsRevoked > 0
          ? `Password changed. You were also logged out on ${res.otherSessionsRevoked} other device${res.otherSessionsRevoked === 1 ? "" : "s"}.`
          : "Password changed.",
      );
    } catch (err) {
      setChangeError(err instanceof ApiError ? err.message : "Could not change password.");
    } finally {
      setChanging(false);
    }
  }

  async function handleLogoutOthers() {
    if (!window.confirm("Log out every other device/browser currently signed into this account?")) {
      return;
    }
    setLoggingOut(true);
    setLogoutError(null);
    setLogoutMessage(null);
    try {
      const res = await apiPost<{ ok: true; otherSessionsRevoked: number }>(
        "/api/auth/logout-others",
        {},
      );
      setLogoutMessage(
        res.otherSessionsRevoked > 0
          ? `Logged out on ${res.otherSessionsRevoked} other device${res.otherSessionsRevoked === 1 ? "" : "s"}.`
          : "No other active sessions were found.",
      );
    } catch (err) {
      setLogoutError(err instanceof ApiError ? err.message : "Could not log out other sessions.");
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleChangePassword}
        className="rounded-lg border border-hairline bg-surface-2 p-5"
      >
        <h2 className="text-sm font-semibold text-ink">Change password</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Changing your password automatically logs out any other device signed into this
          account — this device stays signed in.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-secondary">Current password</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-secondary">New password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-secondary">Confirm new password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
            />
          </label>
        </div>

        {changeError && <p className="mt-3 text-sm text-red-400">{changeError}</p>}
        {changeSuccess && <p className="mt-3 text-sm text-emerald-400">{changeSuccess}</p>}

        <button
          type="submit"
          disabled={changing}
          className="mt-4 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {changing ? "Changing…" : "Change password"}
        </button>
      </form>

      <div className="rounded-lg border border-hairline bg-surface-2 p-5">
        <h2 className="text-sm font-semibold text-ink">Active sessions</h2>
        <p className="mt-1 text-xs text-ink-muted">
          If you signed in on a device you no longer have access to, or think your account may
          be logged in somewhere you don&apos;t recognize, log out everywhere else. This device
          stays signed in.
        </p>

        {logoutError && <p className="mt-3 text-sm text-red-400">{logoutError}</p>}
        {logoutMessage && <p className="mt-3 text-sm text-emerald-400">{logoutMessage}</p>}

        <button
          type="button"
          onClick={handleLogoutOthers}
          disabled={loggingOut}
          className="mt-4 rounded-md border border-hairline-strong px-4 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loggingOut ? "Logging out…" : "Log out other devices"}
        </button>
      </div>

      <TwoFactorCard />
    </div>
  );
}

type MfaStatus = { enabled: boolean; enabledAt: string | null; backupCodesRemaining: number };
type EnrollmentData = { secret: string; otpauthUri: string; qrDataUrl: string };

/**
 * Commercial Launch Phase B.4 — self-service TOTP enrollment/disable, the
 * natural third card alongside change-password and active-sessions (same
 * card styling, same apiPost/ApiError pattern). Three sub-states: off
 * (show "Enable"), mid-enrollment (QR + code entry, then a one-time
 * backup-codes reveal), and on (status + disable/regenerate, both gated
 * behind re-entering the current password).
 */
function TwoFactorCard() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [enrollment, setEnrollment] = useState<EnrollmentData | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [revealedCodes, setRevealedCodes] = useState<string[] | null>(null);

  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const [showRegen, setShowRegen] = useState(false);
  const [regenPassword, setRegenPassword] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  async function loadStatus() {
    try {
      const res = await apiGet<MfaStatus>("/api/auth/mfa");
      setStatus(res);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof ApiError ? err.message : "Could not load two-factor status.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function startEnroll() {
    setEnrollError(null);
    try {
      const res = await apiPost<EnrollmentData>("/api/auth/mfa/enroll", {});
      setEnrollment(res);
      setEnrollCode("");
    } catch (err) {
      setEnrollError(err instanceof ApiError ? err.message : "Could not start enrollment.");
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!enrollment) return;
    setEnrolling(true);
    setEnrollError(null);
    try {
      const res = await apiPost<{ ok: true; backupCodes: string[] }>("/api/auth/mfa/enroll/confirm", {
        secret: enrollment.secret,
        code: enrollCode,
      });
      setRevealedCodes(res.backupCodes);
      setEnrollment(null);
    } catch (err) {
      setEnrollError(err instanceof ApiError ? err.message : "Could not confirm that code.");
    } finally {
      setEnrolling(false);
    }
  }

  function finishEnrollReveal() {
    setRevealedCodes(null);
    loadStatus();
  }

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setDisabling(true);
    setDisableError(null);
    try {
      await apiPost("/api/auth/mfa/disable", { currentPassword: disablePassword });
      setShowDisable(false);
      setDisablePassword("");
      await loadStatus();
    } catch (err) {
      setDisableError(err instanceof ApiError ? err.message : "Could not disable two-factor authentication.");
    } finally {
      setDisabling(false);
    }
  }

  async function handleRegenerate(e: React.FormEvent) {
    e.preventDefault();
    setRegenerating(true);
    setRegenError(null);
    try {
      const res = await apiPost<{ ok: true; backupCodes: string[] }>("/api/auth/mfa/backup-codes/regenerate", {
        currentPassword: regenPassword,
      });
      setShowRegen(false);
      setRegenPassword("");
      setRevealedCodes(res.backupCodes);
    } catch (err) {
      setRegenError(err instanceof ApiError ? err.message : "Could not regenerate backup codes.");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="rounded-lg border border-hairline bg-surface-2 p-5">
      <h2 className="text-sm font-semibold text-ink">Two-factor authentication</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Require a code from an authenticator app (Google Authenticator, Authy, etc.) in addition
        to your password when signing in.
      </p>

      {statusError && <p className="mt-3 text-sm text-red-400">{statusError}</p>}

      {revealedCodes ? (
        <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/15 p-4">
          <p className="text-sm font-semibold text-amber-300">Save these backup codes now</p>
          <p className="mt-1 text-xs text-amber-300">
            Each code works once, if you ever lose access to your authenticator app. They won&apos;t
            be shown again — store them somewhere safe.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-ink sm:grid-cols-3">
            {revealedCodes.map((code) => (
              <div key={code} className="rounded border border-amber-500/30 bg-surface-2 px-2 py-1 text-center">
                {code}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={finishEnrollReveal}
            className="mt-4 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
          >
            I&apos;ve saved these codes
          </button>
        </div>
      ) : loading ? (
        <p className="mt-3 text-sm text-ink-muted">Loading…</p>
      ) : enrollment ? (
        <form onSubmit={confirmEnroll} className="mt-4 space-y-3">
          <p className="text-sm text-ink-secondary">
            Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, not an optimizable remote image */}
          <img
            src={enrollment.qrDataUrl}
            alt="Scan with your authenticator app"
            width={200}
            height={200}
            className="rounded-md border border-hairline"
          />
          <p className="text-xs text-ink-muted">
            Can&apos;t scan? Enter this key manually:{" "}
            <span className="font-mono text-ink-secondary">{enrollment.secret}</span>
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-secondary">6-digit code</span>
            <input
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value)}
              required
              inputMode="numeric"
              maxLength={6}
              className="w-full max-w-[10rem] rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
              autoFocus
            />
          </label>
          {enrollError && <p className="text-sm text-red-400">{enrollError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEnrollment(null)}
              disabled={enrolling}
              className="rounded-md border border-hairline-strong px-4 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              disabled={enrolling}
              className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {enrolling ? "Confirming…" : "Confirm and enable"}
            </button>
          </div>
        </form>
      ) : status?.enabled ? (
        <div className="mt-4 space-y-3">
          <p className="flex items-center gap-1.5 text-sm text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" /> Two-factor authentication
            is on
          </p>
          <p className="text-xs text-ink-muted">
            {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? "" : "s"}{" "}
            remaining.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowRegen((v) => !v)}
              className="rounded-md border border-hairline-strong px-4 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1"
            >
              Regenerate backup codes
            </button>
            <button
              type="button"
              onClick={() => setShowDisable((v) => !v)}
              className="rounded-md border border-hairline-strong px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-500/15"
            >
              Disable
            </button>
          </div>

          {showRegen && (
            <form onSubmit={handleRegenerate} className="rounded-md border border-hairline bg-surface-1 p-3">
              <p className="text-xs text-ink-secondary">
                This invalidates your current backup codes. Confirm your password to continue.
              </p>
              <input
                type="password"
                value={regenPassword}
                onChange={(e) => setRegenPassword(e.target.value)}
                required
                placeholder="Current password"
                className="mt-2 w-full max-w-xs rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
              />
              {regenError && <p className="mt-2 text-sm text-red-400">{regenError}</p>}
              <button
                disabled={regenerating}
                className="mt-2 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {regenerating ? "Regenerating…" : "Regenerate"}
              </button>
            </form>
          )}

          {showDisable && (
            <form onSubmit={handleDisable} className="rounded-md border border-hairline bg-surface-1 p-3">
              <p className="text-xs text-ink-secondary">
                Confirm your password to turn off two-factor authentication.
              </p>
              <input
                type="password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                required
                placeholder="Current password"
                className="mt-2 w-full max-w-xs rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
              />
              {disableError && <p className="mt-2 text-sm text-red-400">{disableError}</p>}
              <button
                disabled={disabling}
                className="mt-2 rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {disabling ? "Disabling…" : "Disable two-factor authentication"}
              </button>
            </form>
          )}
        </div>
      ) : (
        <div className="mt-4">
          {enrollError && <p className="mb-2 text-sm text-red-400">{enrollError}</p>}
          <button
            type="button"
            onClick={startEnroll}
            className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
          >
            Enable two-factor authentication
          </button>
        </div>
      )}
    </div>
  );
}
