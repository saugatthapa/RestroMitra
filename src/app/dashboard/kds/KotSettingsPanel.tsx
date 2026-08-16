"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

/**
 * Phase 17 — the "custom header config" piece of the KOT system: lets an
 * owner override what prints at the top of every Kitchen Order Ticket
 * (defaults to the restaurant's own name — see resolveKotHeaderText in
 * kot-ticket.ts). Lives on the KDS page rather than a general restaurant-
 * settings screen since there isn't one yet (Settings is still a "Coming
 * soon" placeholder) — this is a small, self-contained control for the one
 * field that matters here, not a stand-in for that future page.
 */
export function KotSettingsPanel({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [restaurantName, setRestaurantName] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    apiGet<{ restaurantName: string; kotHeaderText: string | null }>(`${base(slug)}/kot-settings`)
      .then((res) => {
        if (cancelled) return;
        setRestaurantName(res.restaurantName);
        setHeaderText(res.kotHeaderText ?? "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load ticket settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, slug]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiPatch(`${base(slug)}/kot-settings`, { kotHeaderText: headerText.trim() });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save ticket settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
      >
        Ticket settings
      </button>
    );
  }

  return (
    <div className="w-72 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-neutral-700">Ticket header</p>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-400 hover:text-neutral-700"
        >
          Close
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-neutral-400">Loading…</p>
      ) : (
        <>
          <input
            className="input mb-1.5 text-sm"
            placeholder={restaurantName || "Restaurant name"}
            value={headerText}
            onChange={(e) => {
              setHeaderText(e.target.value);
              setSaved(false);
            }}
            maxLength={200}
          />
          <p className="mb-2 text-[11px] text-neutral-400">
            Printed at the top of every kitchen ticket. Leave blank to use the restaurant name (
            {restaurantName}).
          </p>
          {error && <p className="mb-2 text-[11px] text-red-700">{error}</p>}
          {saved && !error && <p className="mb-2 text-[11px] text-green-700">Saved.</p>}
          <button
            onClick={save}
            disabled={saving}
            className="btn-secondary w-full text-xs disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      )}
    </div>
  );
}
