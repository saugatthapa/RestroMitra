"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";

type PlatformRole = "platform_admin" | "super_admin" | "support_admin" | "billing_admin" | "platform_viewer";

const ROLE_LABELS: Record<PlatformRole, string> = {
  platform_admin: "Platform admin (full access)",
  super_admin: "Super admin (full access + can manage admins)",
  support_admin: "Support admin",
  billing_admin: "Billing admin",
  platform_viewer: "Platform viewer (read-only)",
};

type Grant = {
  id: string;
  role: PlatformRole;
  isActive: boolean;
  createdAt: string;
  userId: string;
  fullName: string;
  phone: string;
  mfaEnabled: boolean;
};

export function PlatformRolesBoard() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<PlatformRole>("support_admin");
  const [reason, setReason] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<Grant | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ grants: Grant[] }>("/api/admin/platform-roles");
      setGrants(res.grants);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load platform admins.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault();
    setGranting(true);
    setGrantError(null);
    try {
      await apiPost("/api/admin/platform-roles", { phone, role, reason });
      setPhone("");
      setReason("");
      await load();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Could not grant that role.");
    } finally {
      setGranting(false);
    }
  }

  async function handleRevoke(e: React.FormEvent) {
    e.preventDefault();
    if (!revokeTarget) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await apiDelete(`/api/admin/platform-roles/${revokeTarget.id}`, { reason: revokeReason });
      setRevokeTarget(null);
      setRevokeReason("");
      await load();
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : "Could not revoke that role.");
    } finally {
      setRevoking(false);
    }
  }

  const active = grants.filter((g) => g.isActive);

  return (
    <div className="space-y-6">
      <form onSubmit={handleGrant} className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Grant a platform role</h2>
        <p className="mt-1 text-xs text-neutral-500">
          The phone number must already belong to a registered account — this doesn&apos;t create
          a new one.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">Phone number</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              placeholder="98XXXXXXXX"
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as PlatformRole)}
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            >
              {(Object.keys(ROLE_LABELS) as PlatformRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-neutral-700">Reason (recorded in the audit log)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            placeholder="e.g. Joining as support lead"
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
        {grantError && <p className="mt-3 text-sm text-red-600">{grantError}</p>}
        <button
          type="submit"
          disabled={granting}
          className="mt-4 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {granting ? "Granting…" : "Grant role"}
        </button>
      </form>

      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Active platform admins</h2>
        </div>
        {error && <p className="p-5 text-sm text-red-600">{error}</p>}
        {loading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : active.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">No active platform role grants.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {active.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="text-sm font-medium text-neutral-900">{g.fullName}</p>
                  <p className="text-xs text-neutral-500">
                    {g.phone} · {ROLE_LABELS[g.role]}
                  </p>
                  {!g.mfaEnabled && (
                    <p className="mt-0.5 text-xs font-medium text-amber-700">
                      MFA not enabled — actions will be rejected until they turn it on.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setRevokeTarget(g);
                    setRevokeReason("");
                    setRevokeError(null);
                  }}
                  className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {revokeTarget && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={handleRevoke}
            className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg"
          >
            <h3 className="text-sm font-semibold text-neutral-900">
              Revoke {ROLE_LABELS[revokeTarget.role]} from {revokeTarget.fullName}?
            </h3>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-neutral-700">Reason (recorded in the audit log)</span>
              <input
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                required
                minLength={3}
                autoFocus
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
              />
            </label>
            {revokeError && <p className="mt-2 text-sm text-red-600">{revokeError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
                className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={revoking}
                className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {revoking ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
