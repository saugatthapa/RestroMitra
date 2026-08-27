"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { FEATURES, FEATURE_DESCRIPTIONS, type FeatureKey } from "@/lib/feature-catalog";
import type { Plan } from "@/lib/plans";

const FEATURE_KEY_LIST = Object.values(FEATURES) as FeatureKey[];

type PlanFormState = {
  key: string;
  name: string;
  tagline: string;
  priceInPaisaMonthly: string;
  maxStaff: string; // "" = unlimited
  maxBranches: string; // "" = unlimited
  highlight: boolean;
  features: string; // newline-separated, converted to string[] on submit
  featureKeys: FeatureKey[];
  sortOrder: string;
  isActive: boolean;
};

function planToFormState(plan: Plan): PlanFormState {
  return {
    key: plan.key,
    name: plan.name,
    tagline: plan.tagline,
    priceInPaisaMonthly: String(plan.priceInPaisaMonthly / 100),
    maxStaff: plan.maxStaff === null ? "" : String(plan.maxStaff),
    maxBranches: plan.maxBranches === null ? "" : String(plan.maxBranches),
    highlight: plan.highlight,
    features: plan.features.join("\n"),
    featureKeys: plan.featureKeys as FeatureKey[],
    sortOrder: String(plan.sortOrder),
    isActive: plan.isActive,
  };
}

const EMPTY_FORM: PlanFormState = {
  key: "",
  name: "",
  tagline: "",
  priceInPaisaMonthly: "",
  maxStaff: "",
  maxBranches: "",
  highlight: false,
  features: "",
  featureKeys: [],
  sortOrder: "0",
  isActive: true,
};

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN")}`;
}

export function PlansBoard() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<PlanFormState>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editKey, setEditKey] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<PlanFormState | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [toggleBusyKey, setToggleBusyKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ plans: Plan[] }>("/api/admin/plans");
      setPlans(res.plans);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load plans.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toPayload(form: PlanFormState) {
    return {
      name: form.name,
      tagline: form.tagline,
      priceInPaisaMonthly: Math.round(Number(form.priceInPaisaMonthly) * 100),
      maxStaff: form.maxStaff === "" ? null : Number(form.maxStaff),
      maxBranches: form.maxBranches === "" ? null : Number(form.maxBranches),
      highlight: form.highlight,
      features: form.features.split("\n").map((f) => f.trim()).filter(Boolean),
      featureKeys: form.featureKeys,
      sortOrder: Number(form.sortOrder),
      isActive: form.isActive,
    };
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiPost("/api/admin/plans", { key: createForm.key, ...toPayload(createForm) });
      setCreating(false);
      setCreateForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create that plan.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editKey || !editForm) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await apiPatch(`/api/admin/plans/${editKey}`, toPayload(editForm));
      setEditKey(null);
      setEditForm(null);
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally {
      setEditBusy(false);
    }
  }

  async function toggleActive(plan: Plan) {
    setToggleBusyKey(plan.key);
    try {
      await apiPatch(`/api/admin/plans/${plan.key}`, { isActive: !plan.isActive });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that plan.");
    } finally {
      setToggleBusyKey(null);
    }
  }

  function toggleFeatureKey(form: PlanFormState, key: FeatureKey): PlanFormState {
    const has = form.featureKeys.includes(key);
    return {
      ...form,
      featureKeys: has ? form.featureKeys.filter((k) => k !== key) : [...form.featureKeys, key],
    };
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Plan catalog</h2>
          {!creating && (
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setCreateForm(EMPTY_FORM);
                setCreateError(null);
              }}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
            >
              New plan
            </button>
          )}
        </div>

        {error && <p className="p-5 text-sm text-red-600">{error}</p>}
        {loading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : plans.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">No plans yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {plans.map((plan) => (
              <li key={plan.key} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                      {plan.name}
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-500">
                        {plan.key}
                      </span>
                      {plan.highlight && (
                        <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">
                          Highlighted
                        </span>
                      )}
                      {!plan.isActive && (
                        <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                          Retired
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {formatRupees(plan.priceInPaisaMonthly)}/mo · staff{" "}
                      {plan.maxStaff === null ? "unlimited" : plan.maxStaff} · branches{" "}
                      {plan.maxBranches === null ? "unlimited" : plan.maxBranches} · {plan.tagline}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditKey(plan.key);
                        setEditForm(planToFormState(plan));
                        setEditError(null);
                      }}
                      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={toggleBusyKey === plan.key}
                      onClick={() => toggleActive(plan)}
                      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {plan.isActive ? "Retire" : "Reinstate"}
                    </button>
                  </div>
                </div>

                {editKey === plan.key && editForm && (
                  <form onSubmit={handleEditSave} className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-4">
                    <PlanFields form={editForm} onChange={setEditForm} onToggleFeatureKey={toggleFeatureKey} />
                    {editError && <p className="mt-3 text-sm text-red-600">{editError}</p>}
                    <div className="mt-4 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditKey(null);
                          setEditForm(null);
                        }}
                        disabled={editBusy}
                        className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={editBusy}
                        className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {editBusy ? "Saving…" : "Save changes"}
                      </button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-neutral-900">New plan</h2>
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-neutral-700">
              Key (permanent — used in URLs, events, and audit history)
            </span>
            <input
              value={createForm.key}
              onChange={(e) => setCreateForm({ ...createForm, key: e.target.value })}
              required
              placeholder="e.g. scale"
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </label>
          <div className="mt-3">
            <PlanFields form={createForm} onChange={setCreateForm} onToggleFeatureKey={toggleFeatureKey} />
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
              {createBusy ? "Creating…" : "Create plan"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PlanFields({
  form,
  onChange,
  onToggleFeatureKey,
}: {
  form: PlanFormState;
  onChange: (form: PlanFormState) => void;
  onToggleFeatureKey: (form: PlanFormState, key: FeatureKey) => PlanFormState;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Name</span>
          <input
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            required
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Tagline</span>
          <input
            value={form.tagline}
            onChange={(e) => onChange({ ...form, tagline: e.target.value })}
            required
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Price (Rs/mo)</span>
          <input
            type="number"
            min={0}
            step="1"
            value={form.priceInPaisaMonthly}
            onChange={(e) => onChange({ ...form, priceInPaisaMonthly: e.target.value })}
            required
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Max staff (blank = unlimited)</span>
          <input
            type="number"
            min={0}
            value={form.maxStaff}
            onChange={(e) => onChange({ ...form, maxStaff: e.target.value })}
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Max branches (blank = unlimited)</span>
          <input
            type="number"
            min={0}
            value={form.maxBranches}
            onChange={(e) => onChange({ ...form, maxBranches: e.target.value })}
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Sort order</span>
          <input
            type="number"
            value={form.sortOrder}
            onChange={(e) => onChange({ ...form, sortOrder: e.target.value })}
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-700">Marketing features (one per line)</span>
        <textarea
          value={form.features}
          onChange={(e) => onChange({ ...form, features: e.target.value })}
          rows={4}
          className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
        />
      </label>
      <div className="text-sm">
        <span className="mb-1 block text-neutral-700">Entitled features (gated by the entitlement engine)</span>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {FEATURE_KEY_LIST.map((key) => (
            <label key={key} className="flex items-center gap-2 text-xs text-neutral-600">
              <input
                type="checkbox"
                checked={form.featureKeys.includes(key)}
                onChange={() => onChange(onToggleFeatureKey(form, key))}
              />
              {FEATURE_DESCRIPTIONS[key]}
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={form.highlight}
            onChange={(e) => onChange({ ...form, highlight: e.target.checked })}
          />
          Highlight as &quot;Most popular&quot;
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => onChange({ ...form, isActive: e.target.checked })}
          />
          Offered to new signups (active)
        </label>
      </div>
    </div>
  );
}
