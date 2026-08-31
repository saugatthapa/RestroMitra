"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api-client";

const KNOWN_AI_PROVIDERS = ["groq", "anthropic"] as const;

// Each known provider has exactly one canonical chat-completions endpoint —
// mirrors src/lib/ai/config.ts's own GROQ_API_URL/ANTHROPIC config (kept as
// a small duplicated constant here rather than importing that server-only
// module into this client component). An admin picking a provider should
// never need to know or type its API URL; this is what makes that field
// auto-fill instead of asking for it.
const DEFAULT_API_URLS: Record<(typeof KNOWN_AI_PROVIDERS)[number], string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

type AiProviderConfig = {
  id: string;
  provider: string;
  model: string;
  apiUrl: string;
  isEnabled: boolean;
  priority: number;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

type PlatformAiUsageRow = {
  restaurantId: string;
  restaurantName: string;
  totalAttempts: number;
  successfulAttempts: number;
  totalEstimatedCostInPaisa: number;
};

type RecentAiUsageEvent = {
  id: string;
  restaurantId: string;
  restaurantName: string;
  provider: string;
  model: string;
  success: boolean;
  errorMessage: string | null;
  totalTokens: number | null;
  estimatedCostInPaisa: number | null;
  latencyMs: number | null;
  createdAt: string;
};

type FormState = {
  provider: (typeof KNOWN_AI_PROVIDERS)[number];
  apiKey: string;
  model: string;
  apiUrl: string;
  isEnabled: boolean;
  priority: string;
};

const EMPTY_FORM: FormState = {
  provider: "groq",
  apiKey: "",
  model: "",
  apiUrl: DEFAULT_API_URLS.groq,
  isEnabled: true,
  priority: "0",
};

function formatPaisa(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function AiProvidersBoard() {
  const [configs, setConfigs] = useState<AiProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [usageByRestaurant, setUsageByRestaurant] = useState<PlatformAiUsageRow[]>([]);
  const [recentEvents, setRecentEvents] = useState<RecentAiUsageEvent[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ configs: AiProviderConfig[] }>("/api/admin/ai-providers");
      setConfigs(res.configs);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load AI provider configs.");
    } finally {
      setLoading(false);
    }
  }

  async function loadUsage() {
    setUsageLoading(true);
    try {
      const res = await apiGet<{ byRestaurant: PlatformAiUsageRow[]; recentEvents: RecentAiUsageEvent[] }>(
        "/api/admin/ai-usage",
      );
      setUsageByRestaurant(res.byRestaurant);
      setRecentEvents(res.recentEvents);
    } catch {
      // Non-critical for the page's core function (managing configs) — a
      // usage-load failure shouldn't block the config management UI above.
    } finally {
      setUsageLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadUsage();
  }, []);

  function toPayload(form: FormState) {
    return {
      provider: form.provider,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      model: form.model.trim(),
      apiUrl: form.apiUrl.trim(),
      isEnabled: form.isEnabled,
      priority: Number(form.priority),
    };
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiPost("/api/admin/ai-providers", toPayload(createForm));
      setCreating(false);
      setCreateForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not save that provider config.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editId || !editForm) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await apiPatch(`/api/admin/ai-providers/${editId}`, toPayload(editForm));
      setEditId(null);
      setEditForm(null);
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not save that provider config.");
    } finally {
      setEditBusy(false);
    }
  }

  async function handleDelete(config: AiProviderConfig) {
    setDeleteBusyId(config.id);
    try {
      await apiDelete(`/api/admin/ai-providers/${config.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove that provider config.");
    } finally {
      setDeleteBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Provider configs</h2>
          {!creating && (
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setCreateError(null);
                setCreateForm(EMPTY_FORM);
              }}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
            >
              Add provider
            </button>
          )}
        </div>
        {error && <p className="p-5 text-sm text-red-600">{error}</p>}
        {loading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : configs.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">
            No provider configs yet — the assistant is using the env-var-based configuration
            (AI_PROVIDER / GROQ_API_KEY / ANTHROPIC_API_KEY).
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {configs.map((config) => (
              <li key={config.id} className="p-4">
                {editId === config.id && editForm ? (
                  <form onSubmit={handleEditSave} className="space-y-3">
                    <ProviderFormFields form={editForm} onChange={setEditForm} lockProvider />
                    {editError && <p className="text-sm text-red-600">{editError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditId(null);
                          setEditForm(null);
                        }}
                        disabled={editBusy}
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={editBusy}
                        className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {editBusy ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                        {config.provider}
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-500">
                          {config.model}
                        </span>
                        {config.isEnabled ? (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            Enabled
                          </span>
                        ) : (
                          <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                            Disabled
                          </span>
                        )}
                        {!config.hasApiKey && (
                          <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                            No key set
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        priority {config.priority} (lower tried first) · {config.apiUrl}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditId(config.id);
                          setEditForm({
                            provider: config.provider as FormState["provider"],
                            apiKey: "",
                            model: config.model,
                            apiUrl: config.apiUrl,
                            isEnabled: config.isEnabled,
                            priority: String(config.priority),
                          });
                          setEditError(null);
                        }}
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={deleteBusyId === config.id}
                        onClick={() => handleDelete(config)}
                        className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {deleteBusyId === config.id ? "Removing…" : "Remove"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Add provider</h2>
          <p className="mt-1 text-xs text-neutral-500">
            The API key is encrypted (AES-256-GCM) before it&apos;s stored and is never shown
            again after saving.
          </p>
          <div className="mt-4 space-y-3">
            <ProviderFormFields form={createForm} onChange={setCreateForm} requireApiKey />
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
              {createBusy ? "Saving…" : "Add provider"}
            </button>
          </div>
        </form>
      )}

      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Usage & cost this month</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Cost is a rough estimate from token counts — not a billing-accurate figure. Resets on
            the 1st of the UTC calendar month.
          </p>
        </div>
        {usageLoading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : usageByRestaurant.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">No AI assistant usage recorded this month yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {usageByRestaurant.map((row) => (
              <li key={row.restaurantId} className="flex items-center justify-between gap-4 p-4">
                <p className="text-sm font-medium text-neutral-900">{row.restaurantName}</p>
                <p className="text-xs text-neutral-500">
                  {row.successfulAttempts}/{row.totalAttempts} succeeded ·{" "}
                  {formatPaisa(row.totalEstimatedCostInPaisa)} est.
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Recent activity</h2>
        </div>
        {usageLoading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : recentEvents.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500">No recent AI assistant activity.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {recentEvents.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="flex items-center gap-2 text-sm text-neutral-900">
                    {event.restaurantName}
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-500">
                      {event.provider}/{event.model}
                    </span>
                    {event.success ? (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                        OK
                      </span>
                    ) : (
                      <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                        Failed
                      </span>
                    )}
                  </p>
                  {event.errorMessage && (
                    <p className="mt-0.5 text-xs text-red-600">{event.errorMessage}</p>
                  )}
                </div>
                <p className="shrink-0 text-xs text-neutral-500">
                  {new Date(event.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProviderFormFields({
  form,
  onChange,
  lockProvider,
  requireApiKey,
}: {
  form: FormState;
  onChange: (form: FormState) => void;
  lockProvider?: boolean;
  requireApiKey?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-700">Provider</span>
        <select
          value={form.provider}
          disabled={lockProvider}
          onChange={(e) => {
            // Picking a provider also picks its API URL — never something
            // an admin should have to know or type by hand.
            const provider = e.target.value as FormState["provider"];
            onChange({ ...form, provider, apiUrl: DEFAULT_API_URLS[provider] });
          }}
          className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-500"
        >
          {KNOWN_AI_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-700">
          API key {requireApiKey ? "" : "(blank = keep existing)"}
        </span>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
          required={requireApiKey}
          placeholder={requireApiKey ? "" : "••••••••"}
          className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-700">Model</span>
        <input
          value={form.model}
          onChange={(e) => onChange({ ...form, model: e.target.value })}
          required
          placeholder="e.g. llama-3.3-70b-versatile"
          className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-700">API URL (auto-set for the provider)</span>
        <input
          value={form.apiUrl}
          readOnly
          disabled
          className="w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm text-neutral-500 focus:outline-none"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-700">Priority (lower tried first)</span>
        <input
          type="number"
          min={0}
          value={form.priority}
          onChange={(e) => onChange({ ...form, priority: e.target.value })}
          className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
        />
      </label>
      <label className="flex items-center gap-2 self-end text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={form.isEnabled}
          onChange={(e) => onChange({ ...form, isEnabled: e.target.checked })}
        />
        Enabled
      </label>
    </div>
  );
}
