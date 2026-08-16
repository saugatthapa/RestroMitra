// Icon set for the auth pages (login/register) — same hand-authored,
// dependency-free approach and visual language as NavIcon/StatIcon (1.8
// stroke, rounded caps/joins, 24x24 viewBox), so the auth screens read as
// the same product as the dashboard rather than a different design system
// bolted on for one page.
const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const AuthIcon = {
  User: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </svg>
  ),
  Phone: () => (
    <svg {...iconProps}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
      <path d="M11 18.2h2" />
    </svg>
  ),
  Mail: () => (
    <svg {...iconProps}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5L12 13l8.5-6.5" />
    </svg>
  ),
  Lock: () => (
    <svg {...iconProps}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </svg>
  ),
  Eye: () => (
    <svg {...iconProps}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  EyeOff: () => (
    <svg {...iconProps}>
      <path d="M3.5 3.5l17 17" />
      <path d="M10.7 5.7c.4-.1.9-.2 1.3-.2 6 0 9.5 6.5 9.5 6.5a15 15 0 0 1-3.2 3.9M6.6 6.7C4 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.2 0 2.3-.2 3.3-.7" />
      <path d="M9.9 10c-.3.5-.4 1-.4 1.6a2.6 2.6 0 0 0 2.6 2.6c.6 0 1.1-.2 1.6-.5" />
    </svg>
  ),
  Check: () => (
    <svg {...iconProps}>
      <path d="M4 12.5l5 5L20 6" />
    </svg>
  ),
  ShieldCheck: () => (
    <svg {...iconProps}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2.2 2.2L15.5 9.5" />
    </svg>
  ),
  Sparkle: () => (
    <svg {...iconProps}>
      <path d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  ),
};
