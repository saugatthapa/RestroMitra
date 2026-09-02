// Sidebar navigation icon set. Same hand-authored, dependency-free approach
// as StatTile.tsx's StatIcon set, and the same visual language (1.8 stroke,
// rounded caps/joins, 24x24 viewBox) so the sidebar and the stat tiles read
// as one design system rather than two icon styles bolted together.
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

export const NavIcon = {
  Dashboard: () => (
    <svg {...iconProps}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  ),
  Reports: () => (
    <svg {...iconProps}>
      <path d="M5 20V10M12 20V4M19 20v-7" />
      <path d="M3 20h18" />
    </svg>
  ),
  Assistant: () => (
    <svg {...iconProps}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </svg>
  ),
  Orders: () => (
    <svg {...iconProps}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" />
      <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" />
    </svg>
  ),
  Pos: () => (
    <svg {...iconProps}>
      <rect x="4" y="4" width="16" height="11" rx="2" />
      <path d="M9 19h6M12 15v4" />
    </svg>
  ),
  Kitchen: () => (
    <svg {...iconProps}>
      <path d="M12 3c1 3-2 4-2 7a4 4 0 0 0 8 0c0-2-1-3-1-3s1 4-2 4c-2 0-2-2-1-4-2 0-3 2-3 4a5 5 0 0 0 10 0c0-5-4-6-4-8-1 1-1 1-1 0z" />
    </svg>
  ),
  Tables: () => (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v12M19 8v12M9 8v12M15 8v12" />
    </svg>
  ),
  Reservations: () => (
    <svg {...iconProps}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8 3v4M16 3v4" />
      <path d="M9 14h.01M12 14h.01M15 14h.01" />
    </svg>
  ),
  Menu: () => (
    <svg {...iconProps}>
      <path d="M6 3h9a3 3 0 0 1 3 3v15H9a3 3 0 0 1-3-3V3z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  ),
  Inventory: () => (
    <svg {...iconProps}>
      <path d="M3 8l9-5 9 5-9 5-9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  ),
  Staff: () => (
    <svg {...iconProps}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 20c.3-2.7 2-5 4.5-5.6" />
    </svg>
  ),
  Customers: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.5a6 6 0 0 1 11 0" />
    </svg>
  ),
  Coupons: () => (
    <svg {...iconProps}>
      <path d="M4.5 8a2.5 2.5 0 0 0 0 5v1.5A2.5 2.5 0 0 0 7 17h10a2.5 2.5 0 0 0 2.5-2.5V13a2.5 2.5 0 0 1 0-5V6.5A2.5 2.5 0 0 0 17 4H7a2.5 2.5 0 0 0-2.5 2.5V8Z" />
      <path d="M9 4v13" strokeDasharray="2 2" />
    </svg>
  ),
  // Commercial Launch Phase B.8 — Combos. Three items bundled by a bracket,
  // distinct from Coupons' ticket glyph and Menu's list glyph.
  Combos: () => (
    <svg {...iconProps}>
      <rect x="3" y="4" width="6" height="6" rx="1.2" />
      <rect x="9.5" y="14" width="6" height="6" rx="1.2" />
      <rect x="15" y="4" width="6" height="6" rx="1.2" />
      <path d="M6 10v2a2 2 0 0 0 2 2h1M18 10v2a2 2 0 0 1-2 2h-1" />
    </svg>
  ),
  Expenses: () => (
    <svg {...iconProps}>
      <path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2" />
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M16 13.5h.01" />
    </svg>
  ),
  AccountBooks: () => (
    <svg {...iconProps}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      <path d="M9 7h7" />
      <path d="M9 11h7" />
    </svg>
  ),
  Branches: () => (
    <svg {...iconProps}>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <path d="M9 7h.01M13 7h.01M9 11h.01M13 11h.01M9 15h.01M13 15h.01" />
      <path d="M10 20v-3h4v3" />
    </svg>
  ),
  Website: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z" />
    </svg>
  ),
  Billing: () => (
    <svg {...iconProps}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  ),
  AuditLog: () => (
    <svg {...iconProps}>
      <path d="M3 3v6h6" />
      <path d="M3 9a9 9 0 1 1 2.6 6.3" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  Support: () => (
    <svg {...iconProps}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h.01M12 10h.01M16 10h.01" />
    </svg>
  ),
  CashRegister: () => (
    <svg {...iconProps}>
      <rect x="3" y="9" width="18" height="11" rx="2" />
      <path d="M7 9V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3" />
      <path d="M8 14h.01M12 14h.01M16 14h.01" />
    </svg>
  ),
  DailyClosing: () => (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 3v3M16 3v3" />
      <path d="m8.5 14 2 2 4-4" />
    </svg>
  ),
  Settings: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  ),
  ChevronLeft: () => (
    <svg {...iconProps}>
      <path d="M14 6l-6 6 6 6" />
    </svg>
  ),
  ChevronRight: () => (
    <svg {...iconProps}>
      <path d="M10 6l6 6-6 6" />
    </svg>
  ),
  Logout: () => (
    <svg {...iconProps}>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </svg>
  ),
  Bell: () => (
    <svg {...iconProps}>
      <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  ),
  ExternalLink: () => (
    <svg {...iconProps}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </svg>
  ),
  AlertCircle: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  ),
  Calendar: () => (
    <svg {...iconProps}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8 3v4M16 3v4" />
    </svg>
  ),
};
