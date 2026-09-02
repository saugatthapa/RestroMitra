"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

/**
 * P2 gap audit — "negative stock is always allowed by deliberate, disclosed
 * design, with no restaurant-level toggle to disallow it." This panel is
 * that toggle's owner-facing control: restaurants.allowNegativeStock,
 * default true (today's unchanged, permissive behavior) unless an owner
 * explicitly opts into hard enforcement here. Actual enforcement lives in
 * recordStockMovement (src/lib/inventory.ts) — this panel only flips the
 * flag it reads.
 *
 * Same "own small self-contained panel on the feature's own dashboard page"
 * shape as KotSettingsPanel on the KDS page, rather than a general
 * restaurant-settings screen (there isn't one yet).
 */
export function StockEnforcementPanel({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [allowNegativeStock, setAllowNegativeStock] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    apiGet<{ allowNegativeStock: boolean }>(`${base(slug)}/inventory-settings`)
      .then((res) => {
        if (cancelled) return;
        setAllowNegativeStock(res.allowNegativeStock);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load stock settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, slug]);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiPatch<{ allowNegativeStock: boolean }>(`${base(slug)}/inventory-settings`, {
        allowNegativeStock: next,
      });
      setAllowNegativeStock(res.allowNegativeStock);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this setting.");
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
        Stock settings
      </button>
    );
  }

  return (
    <div className="w-80 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-neutral-700">Negative stock</p>
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
          <label className="mb-2 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!allowNegativeStock}
              disabled={saving}
              onChange={(e) => toggle(!e.target.checked)}
            />
            <span className="text-sm text-neutral-700">
              Block orders, adjustments, and transfers that would take a branch&apos;s stock negative
            </span>
          </label>
          <p className="mb-2 text-[11px] text-neutral-400">
            Off by default: a sale, waste entry, stock-count correction, or transfer that runs out of an
            ingredient still goes through, and the item&apos;s stock shows negative (so you can see it ran
            out). Turn this on for hard enforcement instead — the specific operation is rejected with an
            error rather than allowed to go below zero. Existing negative stock isn&apos;t fixed
            retroactively; this only stops new deductions from going further negative.
          </p>
          {error && <p className="mb-2 text-[11px] text-red-700">{error}</p>}
          {saved && !error && !saving && <p className="mb-2 text-[11px] text-green-700">Saved.</p>}
        </>
      )}
    </div>
  );
}
