"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";
import { whatsappLink } from "@/lib/whatsapp";

type VerificationContact = {
  instagramUrl: string | null;
  tiktokUrl: string | null;
  whatsappNumber: string | null;
  message: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
};

/**
 * Edits the WhatsApp/Instagram/TikTok contact details and message shown on
 * /verify-account — see verification-contact-db.ts and restaurants.verifiedAt's
 * own schema comment for the feature this backs. Own independent fetch
 * against GET /api/admin/system (same "each panel loads itself" shape as
 * SystemHealthPanel next to it on this page) rather than sharing that
 * panel's state, so a slow/failed load here never blocks the health panel
 * or vice versa.
 */
export function VerificationContactPanel() {
  const [data, setData] = useState<VerificationContact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [instagramUrl, setInstagramUrl] = useState("");
  const [tiktokUrl, setTiktokUrl] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [message, setMessage] = useState("");

  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    try {
      const res = await apiGet<{ verificationContact: VerificationContact }>("/api/admin/system");
      setData(res.verificationContact);
      setInstagramUrl(res.verificationContact.instagramUrl ?? "");
      setTiktokUrl(res.verificationContact.tiktokUrl ?? "");
      setWhatsappNumber(res.verificationContact.whatsappNumber ?? "");
      setMessage(res.verificationContact.message ?? "");
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load verification contact details.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      await apiPatch("/api/admin/system/verification-contact", {
        instagramUrl: instagramUrl.trim(),
        tiktokUrl: tiktokUrl.trim(),
        whatsappNumber: whatsappNumber.trim(),
        message: message.trim(),
      });
      setSaved(true);
      await load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save these details.");
    } finally {
      setBusy(false);
    }
  }

  const previewLink = whatsappNumber.trim() ? whatsappLink(whatsappNumber.trim()) : null;

  if (loadError && !data) return <p className="text-sm text-red-600">{loadError}</p>;
  if (!data) return <p className="text-sm text-neutral-400">Loading…</p>;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-semibold text-neutral-900">New-signup verification contact</h2>
      <p className="mb-4 text-xs text-neutral-500">
        Shown on /verify-account, where an unverified restaurant is blocked until you confirm
        them (see the Verification panel on each restaurant&apos;s detail page). No payment
        gateway is integrated yet, so this is how new signups reach you.
      </p>

      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Instagram URL</span>
          <input
            className="input"
            value={instagramUrl}
            onChange={(e) => {
              setInstagramUrl(e.target.value);
              setSaved(false);
            }}
            placeholder="https://www.instagram.com/…"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">TikTok URL</span>
          <input
            className="input"
            value={tiktokUrl}
            onChange={(e) => {
              setTiktokUrl(e.target.value);
              setSaved(false);
            }}
            placeholder="https://www.tiktok.com/@…"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">WhatsApp number</span>
          <input
            className="input"
            value={whatsappNumber}
            onChange={(e) => {
              setWhatsappNumber(e.target.value);
              setSaved(false);
            }}
            placeholder="9815300234"
          />
          {previewLink && (
            <span className="mt-1 block text-[11px] text-neutral-400">Links to {previewLink}</span>
          )}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Message shown to blocked users</span>
          <textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setSaved(false);
            }}
            rows={3}
            className="input"
            maxLength={1000}
          />
        </label>

        {data.updatedAt && (
          <p className="text-[11px] text-neutral-400">
            Last updated {new Date(data.updatedAt).toLocaleString()}
            {data.updatedByName && ` by ${data.updatedByName}`}.
          </p>
        )}
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}
        {saved && !saveError && <p className="text-sm text-green-700">Saved.</p>}

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
