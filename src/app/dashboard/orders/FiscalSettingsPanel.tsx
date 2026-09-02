"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

/**
 * Gap-audit P2 fix (fiscal compliance) — lets an owner set/edit the
 * restaurant's PAN/VAT registration numbers, printed on the customer-facing
 * bill once set (see OrderBillView.tsx). Same "lives on the page whose
 * print output it affects, rather than a general restaurant-settings
 * screen since there isn't one yet" placement as KotSettingsPanel.tsx on
 * the KDS page — see that component's own doc comment.
 */
export function FiscalSettingsPanel({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [panNumber, setPanNumber] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    apiGet<{ panNumber: string | null; vatNumber: string | null }>(`${base(slug)}/tax-settings`)
      .then((res) => {
        if (cancelled) return;
        setPanNumber(res.panNumber ?? "");
        setVatNumber(res.vatNumber ?? "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load tax settings.");
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
      await apiPatch(`${base(slug)}/tax-settings`, {
        panNumber: panNumber.trim(),
        vatNumber: vatNumber.trim(),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save tax settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-full border border-hairline px-3 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-1"
      >
        Tax settings
      </button>
    );
  }

  return (
    <div className="w-72 rounded-xl border border-hairline bg-surface-2 p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-ink-secondary">PAN / VAT</p>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-ink-faint hover:text-ink-secondary"
        >
          Close
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : (
        <>
          <input
            className="input mb-1.5 text-sm"
            placeholder="PAN number"
            value={panNumber}
            onChange={(e) => {
              setPanNumber(e.target.value);
              setSaved(false);
            }}
            maxLength={20}
          />
          <input
            className="input mb-1.5 text-sm"
            placeholder="VAT number (if registered)"
            value={vatNumber}
            onChange={(e) => {
              setVatNumber(e.target.value);
              setSaved(false);
            }}
            maxLength={20}
          />
          <p className="mb-2 text-[11px] text-ink-faint">
            Printed on customer bills once set. Leave blank to omit either line — most
            restaurants below the VAT-registration threshold set only PAN.
          </p>
          {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}
          {saved && !error && <p className="mb-2 text-[11px] text-green-400">Saved.</p>}
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
