"use client";

import { useState } from "react";
import { apiPost, ApiError } from "@/lib/api-client";

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
        className="rounded-lg border border-neutral-200 bg-white p-5"
      >
        <h2 className="text-sm font-semibold text-neutral-900">Change password</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Changing your password automatically logs out any other device signed into this
          account — this device stays signed in.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">Current password</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">New password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">Confirm new password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </label>
        </div>

        {changeError && <p className="mt-3 text-sm text-red-600">{changeError}</p>}
        {changeSuccess && <p className="mt-3 text-sm text-emerald-600">{changeSuccess}</p>}

        <button
          type="submit"
          disabled={changing}
          className="mt-4 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {changing ? "Changing…" : "Change password"}
        </button>
      </form>

      <div className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Active sessions</h2>
        <p className="mt-1 text-xs text-neutral-500">
          If you signed in on a device you no longer have access to, or think your account may
          be logged in somewhere you don&apos;t recognize, log out everywhere else. This device
          stays signed in.
        </p>

        {logoutError && <p className="mt-3 text-sm text-red-600">{logoutError}</p>}
        {logoutMessage && <p className="mt-3 text-sm text-emerald-600">{logoutMessage}</p>}

        <button
          type="button"
          onClick={handleLogoutOthers}
          disabled={loggingOut}
          className="mt-4 rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loggingOut ? "Logging out…" : "Log out other devices"}
        </button>
      </div>
    </div>
  );
}
