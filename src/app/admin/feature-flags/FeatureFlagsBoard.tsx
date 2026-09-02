"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";

type FeatureFlag = {
  key: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export function FeatureFlagsBoard() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [toggleBusyKey, setToggleBusyKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ flags: FeatureFlag[] }>("/api/admin/feature-flags");
      setFlags(res.flags);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load feature flags.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiPost("/api/admin/feature-flags", { key, name, description, defaultEnabled });
      setCreating(false);
      setKey("");
      setName("");
      setDescription("");
      setDefaultEnabled(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create that flag.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function toggle(flag: FeatureFlag) {
    setToggleBusyKey(flag.key);
    try {
      await apiPatch(`/api/admin/feature-flags/${flag.key}`, { defaultEnabled: !flag.defaultEnabled });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that flag.");
    } finally {
      setToggleBusyKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Feature flags</h2>
          {!creating && (
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setCreateError(null);
              }}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
            >
              New flag
            </button>
          )}
        </div>
        {error && <p className="p-5 text-sm text-red-600">{error}</p>}
        {loading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : flags.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">No feature flags yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {flags.map((flag) => (
              <li key={flag.key} className="flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                    {flag.name}
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-500">
                      {flag.key}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">{flag.description}</p>
                </div>
                <button
                  type="button"
                  disabled={toggleBusyKey === flag.key}
                  onClick={() => toggle(flag)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                    flag.defaultEnabled
                      ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                  }`}
                >
                  {flag.defaultEnabled ? "Enabled by default" : "Disabled by default"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-neutral-900">New feature flag</h2>
          <p className="mt-1 text-xs text-neutral-500">
            A global default for a capability not (or not only) governed by a restaurant&apos;s
            plan — e.g. an experimental rollout or a kill switch. A specific tenant can still be
            overridden individually from their own restaurant page.
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-700">Key (permanent)</span>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                required
                placeholder="e.g. ai_assistant_v2_beta"
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-700">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-700">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={defaultEnabled}
                onChange={(e) => setDefaultEnabled(e.target.checked)}
              />
              Enabled by default for every restaurant
            </label>
          </div>
          {createError && <p className="mt-3 text-sm text-red-600">{createError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={createBusy}
              className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createBusy}
              className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createBusy ? "Creating…" : "Create flag"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
