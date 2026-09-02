"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";

type Branch = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  isMain: boolean;
  isActive: boolean;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

export function BranchesBoard({ slug }: { slug: string }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    try {
      const res = await apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`);
      setBranches(res.branches);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load branches.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading) return <p className="text-sm text-ink-muted">Loading branches…</p>;

  const activeBranches = branches.filter((b) => b.isActive);
  const inactiveBranches = branches.filter((b) => !b.isActive);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {activeBranches.length} active branch{activeBranches.length === 1 ? "" : "es"}
        </p>
        <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
          {showAdd ? "Cancel" : "+ Branch"}
        </button>
      </div>

      {showAdd && (
        <AddBranchForm
          slug={slug}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activeBranches.map((branch) => (
          <BranchCard key={branch.id} slug={slug} branch={branch} onChanged={load} />
        ))}
      </div>

      {inactiveBranches.length > 0 && (
        <div className="pt-4">
          <p className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Deactivated
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {inactiveBranches.map((branch) => (
              <BranchCard key={branch.id} slug={slug} branch={branch} onChanged={load} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BranchCard({
  slug,
  branch,
  onChanged,
}: {
  slug: string;
  branch: Branch;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function handleRename() {
    const name = window.prompt("Branch name", branch.name);
    if (!name || !name.trim() || name === branch.name) return;
    setSaving(true);
    try {
      await apiPatch(`${base(slug)}/branches/${branch.id}`, { name });
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not rename branch.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (
      branch.isActive &&
      !window.confirm(
        `Deactivate "${branch.name}"? Staff scoped to this branch will lose access until it's reactivated.`,
      )
    )
      return;
    setSaving(true);
    try {
      await apiPatch(`${base(slug)}/branches/${branch.id}`, { isActive: !branch.isActive });
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update branch.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${
        branch.isActive ? "border-hairline bg-surface-2" : "border-hairline/60 bg-surface-1"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">
            {branch.name}
            {branch.isMain && (
              <span className="ml-2 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-400">
                Main
              </span>
            )}
          </p>
          {branch.address && <p className="mt-1 text-xs text-ink-muted">{branch.address}</p>}
          {branch.city && <p className="text-xs text-ink-muted">{branch.city}</p>}
          {branch.phone && <p className="text-xs text-ink-muted">{branch.phone}</p>}
        </div>
      </div>
      <div className="mt-3 flex gap-3 text-xs">
        <button
          disabled={saving}
          onClick={handleRename}
          className="font-medium text-ink-secondary hover:text-ink"
        >
          Rename
        </button>
        {!branch.isMain && (
          <button
            disabled={saving}
            onClick={toggleActive}
            className={`font-medium ${
              branch.isActive ? "text-ink-faint hover:text-red-400" : "text-orange-400 hover:text-orange-300"
            }`}
          >
            {branch.isActive ? "Deactivate" : "Reactivate"}
          </button>
        )}
      </div>
    </div>
  );
}

function AddBranchForm({ slug, onAdded }: { slug: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/branches`, { name, address, city, phone });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create branch.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Branch name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            placeholder="e.g. Dharan Branch"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">City</span>
          <input value={city} onChange={(e) => setCity(e.target.value)} className="input" />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-secondary">Address</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Creating…" : "Create branch"}
      </button>
    </form>
  );
}
