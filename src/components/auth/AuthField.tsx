"use client";

/**
 * Shared input wrapper for the login/register forms — a leading icon
 * (matching AuthIcon's visual language), optional trailing slot (the
 * password show/hide toggle uses this), and an inline status line that
 * can read as neutral hint, error, or success (the phone-format and
 * password-match live-validation feedback both use this rather than each
 * page hand-rolling its own message styling).
 */
export function AuthField({
  label,
  icon,
  trailing,
  status,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  status?: { tone: "hint" | "error" | "success"; message: string } | null;
  children: React.ReactNode;
}) {
  const toneClass =
    status?.tone === "error"
      ? "text-red-400"
      : status?.tone === "success"
        ? "text-green-400"
        : "text-ink-faint";

  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-secondary">{label}</span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
          {icon}
        </span>
        <div className={trailing ? "[&>input]:pl-9 [&>input]:pr-9" : "[&>input]:pl-9 [&>input]:pr-3"}>
          {children}
        </div>
        {trailing && <div className="absolute right-1.5 top-1/2 -translate-y-1/2">{trailing}</div>}
      </div>
      {status && <p className={`mt-1 text-xs ${toneClass}`}>{status.message}</p>}
    </label>
  );
}
