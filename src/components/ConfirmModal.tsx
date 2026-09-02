"use client";

/**
 * A plain, always-visible confirmation dialog — used in place of the
 * browser's native window.confirm() wherever the choice needs to be
 * unmistakable rather than a small OS-styled popup a non-technical user
 * might dismiss without reading (see OrderBillView's "Complete" gate).
 */
export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  busy = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface-2 p-5 shadow-xl">
        <p className="text-base font-semibold text-ink">{title}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{message}</p>
        <div className="mt-5 flex gap-2">
          <button onClick={onCancel} disabled={busy} className="btn-secondary flex-1 disabled:opacity-60">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} disabled={busy} className="btn-primary flex-1 disabled:opacity-60">
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
