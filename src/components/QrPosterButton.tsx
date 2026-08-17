"use client";

import { useState } from "react";
import { downloadQrPoster, type QrPosterOptions } from "@/lib/qr-poster";

/**
 * Thin async wrapper around downloadQrPoster() — owns the "Generating…"
 * disabled state and turns a canvas/image-load failure into a plain alert()
 * instead of an unhandled promise rejection, matching how the rest of the
 * dashboard reports client-side errors (see TablesManager's action
 * handlers).
 */
export function QrPosterButton({
  className,
  children = "Download poster",
  ...opts
}: QrPosterOptions & { className?: string; children?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      await downloadQrPoster(opts);
    } catch {
      alert("Could not generate the poster. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={handleClick} disabled={busy} className={className}>
      {busy ? "Generating…" : children}
    </button>
  );
}
