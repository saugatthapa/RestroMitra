"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { apiGet, apiPost, apiPatch } from "@/lib/api-client";
import { NavIcon } from "@/components/NavIcon";
import { formatAdDate, formatBsDate } from "@/lib/nepali-date";
import { DateSystemProvider, useDateSystemControl, type DateSystem } from "@/lib/date-system";
import { LocaleProvider, useLocaleControl, useTranslation, trialDaysLeftText, type Locale } from "@/lib/i18n";
import { PERMISSIONS, roleHasPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { useOnlineStatus } from "@/lib/use-online-status";
import { DashboardServiceWorker } from "@/components/DashboardServiceWorker";
import { InstallAppPrompt } from "@/components/InstallAppPrompt";
import { NotificationPermissionGate } from "@/components/NotificationPermissionGate";
import { BranchProvider, useActiveBranch, type SelectableBranch } from "@/lib/branch-context";

// Nav is grouped (Overview / Front of house / Back office / Account) with an
// icon per item, rather than one flat 16-item list — the flat list was the
// thing that made our sidebar read as weaker than the reference dashboard
// the user compared us against, which groups its own nav under section
// headers. Restaurant-industry group names ("front of house" / "back
// office") rather than the reference's generic ones, since this is a
// restaurant product specifically.
type NavItem = {
  label: string;
  href: string;
  enabled: boolean;
  icon: React.ReactNode;
  badge?: string;
  /** The permission a role needs to see this item at all — e.g. a waiter
   * has neither VIEW_REPORTS nor MANAGE_STAFF, so Reports and Staff never
   * render in their sidebar (the destination pages redirect away too, if
   * reached directly by URL — this is the visibility half of that same
   * gate). Omitted for items every logged-in role can see (Dashboard,
   * Orders, KDS — screens the whole floor legitimately glances at even
   * without permission to change anything on them). An array means
   * "any of" — e.g. Staff now serves both MANAGE_STAFF (roster/
   * attendance) and VIEW_PAYROLL/MANAGE_PAYROLL (payroll), two
   * deliberately separate grants (see StaffPage's own comment), so an
   * accountant who holds only the payroll permissions still sees the
   * link. */
  permission?: PermissionKey | PermissionKey[];
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const SIDEBAR_COLLAPSED_KEY = "restromitra:sidebar-collapsed";

function daysRemaining(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function initialsOf(name: string): string {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

// A restaurant-branding touch — a colored monogram badge in the header,
// standing in for a real uploaded logo (no logo-upload feature exists yet;
// this is what "every restaurant gets its own visual identity in the
// header" looks like without one). The color is a stable hash of the
// restaurant's name, not random, so it's the same badge on every visit.
const MONOGRAM_PALETTE = [
  { bg: "#fdece3", fg: "#c2450f" },
  { bg: "#e8f0fc", fg: "#2a78d6" },
  { bg: "#e6f4ea", fg: "#1a7f37" },
  { bg: "#f1e9fb", fg: "#7c3aed" },
  { bg: "#e1f5f3", fg: "#0f766e" },
  { bg: "#fef3e0", fg: "#b45309" },
];

function monogramStyle(name: string): { bg: string; fg: string } {
  const sum = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return MONOGRAM_PALETTE[sum % MONOGRAM_PALETTE.length];
}

type HeaderStatus = {
  activeOrders: number;
  kitchenBusy: boolean;
  lowStockCount: number;
  pendingReservationsCount: number;
  pendingOrderIds: string[];
};

type ServiceCallAlert = {
  id: string;
  tableId: string;
  tableName: string;
  status: "pending" | "acknowledged";
};

/**
 * Wraps the whole dashboard tree in DateSystemProvider before anything else
 * renders, so every screen under `children` — not just this header — can
 * call `useDateSystem()` and get the same AD/BS preference the toggle
 * below sets. The actual shell markup lives in DashboardShellContent,
 * which reads that preference back out via `useDateSystemControl()`.
 */
export function DashboardShell({
  branches,
  activeRestaurantId,
  ...rest
}: {
  ownerName: string;
  restaurantName: string;
  role: string;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  slug: string;
  logoUrl: string | null;
  restaurants: { id: string; name: string }[];
  activeRestaurantId: string;
  /** Every branch this user may switch between in the header — see
   *  getSelectableBranches. Feeds BranchProvider, which every screen under
   *  `children` (Reports today, potentially others later) reads via
   *  useActiveBranch() rather than this being threaded through as a prop. */
  branches: SelectableBranch[];
  children: React.ReactNode;
}) {
  return (
    <DateSystemProvider>
      <LocaleProvider>
        <BranchProvider restaurantId={activeRestaurantId} branches={branches}>
          <DashboardShellContent activeRestaurantId={activeRestaurantId} {...rest} />
        </BranchProvider>
      </LocaleProvider>
    </DateSystemProvider>
  );
}

function DashboardShellContent({
  ownerName,
  restaurantName,
  role,
  subscriptionStatus,
  trialEndsAt,
  slug,
  logoUrl,
  restaurants,
  activeRestaurantId,
  children,
}: {
  ownerName: string;
  restaurantName: string;
  role: string;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  /** The active restaurant's slug — scopes the header's live-status poll. */
  slug: string;
  /** Set during onboarding, or later from Settings (see
   * src/app/dashboard/settings/SettingsBoard.tsx) via a client-compressed
   * data: URL — see src/lib/client-image.ts. Null for
   * the common case of a restaurant that hasn't set one, in which case the
   * sidebar falls back to a colored monogram so the brand slot is never
   * empty. */
  logoUrl: string | null;
  /** Every restaurant this user has an active role grant on, for the
   * header's restaurant switcher. A single-restaurant owner (the common
   * case) never sees a switcher at all — no dropdown affordance with
   * nothing to switch to. */
  restaurants: { id: string; name: string }[];
  activeRestaurantId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);
  const [switchingRestaurant, setSwitchingRestaurant] = useState(false);
  const [headerStatus, setHeaderStatus] = useState<HeaderStatus | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const days = daysRemaining(trialEndsAt);
  // QA hardening pass: the sidebar below is `hidden md:flex` — on any
  // screen narrower than 768px (every phone, and a portrait tablet under
  // that width) it disappeared completely with NO fallback, leaving staff
  // with zero way to navigate off whatever page they landed on except
  // typing a URL by hand. This state drives a slide-in drawer (below) that
  // reuses the exact same nav groups, opened via a hamburger button that
  // only renders on those same narrow screens.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Desktop-only icon-rail collapse, persisted so a staff member's
  // preference survives a reload. Same guarded-lazy-initializer pattern
  // POSOrderBuilder.tsx already uses for its `isOnline` state, rather than
  // reading localStorage inside a useEffect (which would mean calling
  // setState synchronously from an effect — an anti-pattern the lint rules
  // here specifically flag).
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  });

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // AD/BS calendar toggle — a per-device preference (like the sidebar
  // collapse state above), not per-restaurant or per-user in the database,
  // since which calendar someone reads dates in has nothing to do with
  // which restaurant they're looking at. Defaults to BS: this is a Nepali
  // restaurant product and staff here think in the Nepali calendar day to
  // day, with AD as the toggle-away option rather than the default. Lives
  // in DateSystemProvider (wrapped around this whole shell, including
  // `children`) rather than local state, so every dashboard screen — not
  // just this header — reads the same preference.
  const { dateSystem, setDateSystem } = useDateSystemControl();
  const { locale, setLocale } = useLocaleControl();
  const { t } = useTranslation();

  // Phase 22 (offline mode) — a shell-wide connectivity indicator. Each
  // page that can actually queue-and-sync a mutation (POS, Orders, KDS)
  // still shows its own more specific "N waiting to sync" banner; this one
  // is the fallback for every OTHER dashboard page, which previously gave
  // staff no signal at all when a background fetch silently failed.
  const isOnline = useOnlineStatus();

  // Live "N active" / "Kitchen Clear|Busy" header pills — same 5s polling
  // cadence OrdersBoard.tsx already uses, backed by a real query
  // (src/app/api/restaurants/[slug]/header-status) rather than a static
  // demo value. A failed poll just leaves the pills showing their last
  // good value (or hidden, before the first success) — never worth an
  // error banner over a background refresh. Also the authoritative source
  // for `pendingOrderIds` (see below) — every 5s reconciliation catches a
  // tab that was opened *after* an order already came in, and self-heals
  // from any SSE event this tab happened to miss (a dropped connection
  // reconnecting, a brief network blip).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await apiGet<HeaderStatus>(`/api/restaurants/${slug}/header-status`);
        if (!cancelled) {
          setHeaderStatus(data);
          setPendingOrderIds(new Set(data.pendingOrderIds));
        }
      } catch {
        // ignore — see comment above
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [slug]);

  const canViewServiceCalls = roleHasPermission(role, PERMISSIONS.VIEW_SERVICE_CALLS);
  const [activeCalls, setActiveCalls] = useState<ServiceCallAlert[]>([]);
  const [callActionBusy, setCallActionBusy] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const orderAlertAudioRef = useRef<HTMLAudioElement | null>(null);

  // Orders still in "pending" (placed, not yet confirmed) — the alarm
  // (below) keeps looping for as long as this set is non-empty, and the
  // banner near the top of the page gives staff the obvious way to stop it:
  // go confirm the order. Reconciled from the header-status poll above and
  // kept live in between by the order.created / order.status_changed SSE
  // handlers further down.
  const [pendingOrderIds, setPendingOrderIds] = useState<Set<string>>(new Set());

  // Perf/reliability audit finding: browsers block audio.play() until the
  // page has been "interacted with," and the old code just swallowed that
  // rejection — no retry, no indication anything was wrong. To staff that
  // looks exactly like "the alarm didn't go off," not "it was blocked,"
  // which is very plausibly what was actually happening rather than the
  // alarm genuinely being slow. `soundBlocked` surfaces that state (see the
  // banner below) with a one-tap fix, instead of failing silently forever.
  const [soundBlocked, setSoundBlocked] = useState(false);

  useEffect(() => {
    // Perf: these were uncompressed WAV (119 KB / 43 KB) — switched to MP3
    // at 128kbps (23 KB / 9 KB, ~80% smaller) with no audible quality loss
    // for a short alert tone, so the very first alarm after a fresh page
    // load (or a patchy mobile connection) doesn't have to wait on a much
    // larger download than it needs to. See PERFORMANCE_AUDIT.md.
    audioRef.current = new Audio("/sounds/service-call-alert.mp3");
    orderAlertAudioRef.current = new Audio("/sounds/new-order-alert.mp3");
    orderAlertAudioRef.current.loop = true;

    // Prime both elements on the very first tap/click/keypress ANYWHERE on
    // the page — a play() immediately followed by a pause() is inaudible
    // (no perceptible sound plays in that split second) but is a genuine
    // user gesture from the browser's perspective, which is what actually
    // lifts the autoplay block for every later .play() call this session.
    // Without this, the very first real alarm after a fresh page load is
    // the single most likely one to be silently blocked — a staff member
    // opening the dashboard and just watching it, with no reason to tap
    // anything, is exactly the case this fixes. `{ once: true }` means this
    // never runs again once it's fired, on success or failure alike.
    function primeAudio() {
      for (const el of [audioRef.current, orderAlertAudioRef.current]) {
        if (!el) continue;
        const wasLooping = el.loop;
        el.loop = false;
        el.play()
          .then(() => {
            el.pause();
            el.currentTime = 0;
            el.loop = wasLooping;
            setSoundBlocked(false);
          })
          .catch(() => {
            el.loop = wasLooping;
            // Still blocked even after a real gesture — rare, but leaves
            // the "tap to enable sound" banner as the fallback.
          });
      }
    }
    document.addEventListener("pointerdown", primeAudio, { once: true });
    document.addEventListener("keydown", primeAudio, { once: true });
    return () => {
      document.removeEventListener("pointerdown", primeAudio);
      document.removeEventListener("keydown", primeAudio);
    };
  }, []);

  // Staff tapping the "tap to enable sound" banner — a direct, unambiguous
  // user gesture, so this retry is effectively guaranteed to succeed (per
  // browser autoplay policy) unlike the automatic attempts above.
  function retryBlockedSound() {
    const audio = orderAlertAudioRef.current;
    if (audio && pendingOrderIds.size > 0) {
      audio.currentTime = 0;
      audio.play().then(() => setSoundBlocked(false)).catch(() => {});
    } else {
      setSoundBlocked(false);
    }
  }

  // Starts/stops the looping new-order alarm to match pendingOrderIds —
  // a plain state comparison rather than reacting to "just got a new one"
  // vs "just cleared the last one" as separate cases, so it's correct
  // however pendingOrderIds changed (an SSE event, a poll reconciliation,
  // several orders confirmed out of order, etc).
  useEffect(() => {
    const audio = orderAlertAudioRef.current;
    if (!audio) return;
    if (pendingOrderIds.size > 0) {
      if (audio.paused) {
        audio.currentTime = 0;
        audio
          .play()
          .then(() => setSoundBlocked(false))
          .catch(() => {
            // Autoplay can be blocked until the user has interacted with
            // the page at least once — surfaced via the banner below (with
            // a one-tap retry) instead of failing invisibly.
            setSoundBlocked(true);
          });
      }
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [pendingOrderIds]);

  // The real-time stream — see src/app/api/restaurants/[slug]/events and
  // src/lib/realtime.ts for what's actually behind it (DB-polling under an
  // SSE connection, not a pure in-memory pub/sub — kept DB-authoritative for
  // correctness/tenant scoping/reconnect catch-up, with a same-process wake
  // fast path added in Phase 25 for near-instant delivery on this app's
  // actual deployment). Mounted once per dashboard session, here at the
  // shell level (not per-page), so it keeps running as staff navigate
  // between Orders/KDS/Staff/etc. without reopening a connection on every
  // route change. Two things happen with what arrives:
  //   1. order.created / order.status_changed — rebroadcast as a plain
  //      window CustomEvent so OrdersBoard/KDSBoard (mounted as `children`
  //      on their own pages) can react instantly on top of their existing
  //      5s poll, without this shell needing to know either component's
  //      internals. order.created also adds the order to `pendingOrderIds`,
  //      which starts the looping alarm below (every role hears it, same as
  //      the live "N active" header pill being ungated — missing a new
  //      order is costly for everyone on shift, not just whoever owns the
  //      Orders page right now); order.status_changed removes it again once
  //      staff confirm (or cancel) the order, which is what actually stops
  //      the alarm. A real system notification for order.created — even
  //      with the app fully closed, not just backgrounded — is now handled
  //      server-side via Web Push (see NotificationPermissionGate and
  //      public/dashboard-sw.js's `push` handler) rather than from this
  //      in-page listener, which can only ever run while some tab is alive.
  //   2. service_call.* — handled directly here: a new call plays the
  //      alert sound and adds a banner (only for roles holding
  //      VIEW_SERVICE_CALLS — kitchen_staff etc. still need the order
  //      events above off this same connection, so the stream itself isn't
  //      gated by that permission, only what it visibly does with calls).
  useEffect(() => {
    const source = new EventSource(`/api/restaurants/${slug}/events`);

    source.addEventListener("order.created", (event) => {
      window.dispatchEvent(new CustomEvent("restromitra:orders-changed"));

      let orderId: string | null = null;
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          orderId?: string;
          orderNumber?: string;
          tableName?: string;
        };
        orderId = data.orderId ?? null;
        if (orderId) {
          setPendingOrderIds((prev) => {
            if (prev.has(orderId as string)) return prev;
            return new Set(prev).add(orderId as string);
          });
        }
        // Phase 25: the in-page `new Notification(...)` call that used to
        // live here (for the "tab open but hidden" case) has been removed —
        // Web Push (see NotificationPermissionGate + public/dashboard-sw.js)
        // now covers that case too, from the service worker's `push`
        // handler, and firing both would show two notifications for the
        // same order on any device that's subscribed. Web Push also covers
        // the case this in-page call never could: the app fully closed, not
        // just backgrounded.
      } catch {
        // Malformed/absent payload — the alarm can't be tied to a specific
        // order in that case, but the poll reconciliation above will still
        // pick up any real pending order within 5s regardless.
      }
    });
    source.addEventListener("order.status_changed", (event) => {
      window.dispatchEvent(new CustomEvent("restromitra:orders-changed"));
      try {
        const data = JSON.parse((event as MessageEvent).data) as { orderId: string; to: string };
        if (data.to !== "pending") {
          setPendingOrderIds((prev) => {
            if (!prev.has(data.orderId)) return prev;
            const next = new Set(prev);
            next.delete(data.orderId);
            return next;
          });
        }
      } catch {
        // Malformed payload — the next 5s poll reconciles pendingOrderIds
        // regardless, so this never leaves the alarm stuck on indefinitely.
      }
    });

    source.addEventListener("service_call.created", (event) => {
      if (!canViewServiceCalls) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          callId: string;
          tableId: string;
          tableName: string;
        };
        setActiveCalls((prev) =>
          prev.some((c) => c.id === data.callId)
            ? prev
            : [...prev, { id: data.callId, tableId: data.tableId, tableName: data.tableName, status: "pending" }],
        );
        audioRef.current
          ?.play()
          .then(() => setSoundBlocked(false))
          .catch(() => {
            // Autoplay can be blocked until the user has interacted with
            // the page at least once — surfaced via the "tap to enable
            // sound" banner instead of failing invisibly.
            setSoundBlocked(true);
          });
      } catch {
        // Malformed event payload — skip it rather than crash the stream.
      }
    });
    source.addEventListener("service_call.acknowledged", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { callId: string };
        setActiveCalls((prev) =>
          prev.map((c) => (c.id === data.callId ? { ...c, status: "acknowledged" } : c)),
        );
      } catch {
        // ignore
      }
    });
    source.addEventListener("service_call.resolved", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { callId: string };
        setActiveCalls((prev) => prev.filter((c) => c.id !== data.callId));
      } catch {
        // ignore
      }
    });

    return () => source.close();
  }, [slug, canViewServiceCalls]);

  async function actOnCall(callId: string, action: "acknowledge" | "resolve") {
    setCallActionBusy(callId);
    try {
      await apiPatch(`/api/restaurants/${slug}/service-calls/${callId}`, { action });
      setActiveCalls((prev) =>
        action === "resolve"
          ? prev.filter((c) => c.id !== callId)
          : prev.map((c) => (c.id === callId ? { ...c, status: "acknowledged" } : c)),
      );
    } catch {
      // A failed tap just leaves the banner as-is — the SSE stream (or the
      // next staff member) will catch it up; nothing silently breaks.
    } finally {
      setCallActionBusy(null);
    }
  }

  const ALL_NAV_GROUPS: NavGroup[] = [
    {
      title: t("nav.overview"),
      items: [
        { label: t("nav.dashboard"), href: "/dashboard", enabled: true, icon: <NavIcon.Dashboard /> },
        {
          label: t("nav.reports"),
          href: "/dashboard/reports",
          enabled: true,
          icon: <NavIcon.Reports />,
          permission: PERMISSIONS.VIEW_REPORTS,
        },
        {
          label: t("nav.aiAssistant"),
          href: "/dashboard/assistant",
          enabled: true,
          icon: <NavIcon.Assistant />,
          permission: PERMISSIONS.VIEW_REPORTS,
        },
      ],
    },
    {
      title: t("nav.frontOfHouse"),
      items: [
        { label: t("nav.orders"), href: "/dashboard/orders", enabled: true, icon: <NavIcon.Orders /> },
        {
          label: t("nav.pos"),
          href: "/dashboard/pos",
          enabled: true,
          icon: <NavIcon.Pos />,
          permission: PERMISSIONS.CREATE_ORDER,
        },
        { label: t("nav.kitchenKds"), href: "/dashboard/kds", enabled: true, icon: <NavIcon.Kitchen /> },
        {
          label: t("nav.tablesQr"),
          href: "/dashboard/tables",
          enabled: true,
          icon: <NavIcon.Tables />,
          permission: PERMISSIONS.MANAGE_TABLES,
        },
        {
          label: t("nav.reservations"),
          href: "/dashboard/reservations",
          enabled: true,
          icon: <NavIcon.Reservations />,
          permission: PERMISSIONS.MANAGE_RESERVATIONS,
        },
      ],
    },
    {
      title: t("nav.backOffice"),
      items: [
        {
          label: t("nav.menu"),
          href: "/dashboard/menu",
          enabled: true,
          icon: <NavIcon.Menu />,
          permission: PERMISSIONS.EDIT_MENU,
        },
        {
          // Commercial Launch Phase B.8 — Combos. Same trust tier as menu
          // items (EDIT_MENU) — a combo is a menu-builder concept, not a
          // checkout-time discretion (that's Coupons/manual discounts under
          // APPLY_DISCOUNT).
          label: t("nav.combos"),
          href: "/dashboard/combos",
          enabled: true,
          icon: <NavIcon.Combos />,
          permission: PERMISSIONS.EDIT_MENU,
        },
        {
          label: t("nav.inventory"),
          href: "/dashboard/inventory",
          enabled: true,
          icon: <NavIcon.Inventory />,
          permission: PERMISSIONS.MANAGE_INVENTORY,
        },
        {
          label: t("nav.staff"),
          href: "/dashboard/staff",
          enabled: true,
          icon: <NavIcon.Staff />,
          permission: [PERMISSIONS.MANAGE_STAFF, PERMISSIONS.VIEW_PAYROLL, PERMISSIONS.MANAGE_PAYROLL],
        },
        {
          label: t("nav.customers"),
          href: "/dashboard/customers",
          enabled: true,
          icon: <NavIcon.Customers />,
          permission: PERMISSIONS.MANAGE_CUSTOMERS,
        },
        {
          // Commercial Launch Phase B.6 — Coupons. Same trust tier as a
          // manual discount (see coupons/route.ts's own comment): a
          // reusable code is just another way to grant a discount.
          label: t("nav.coupons"),
          href: "/dashboard/coupons",
          enabled: true,
          icon: <NavIcon.Coupons />,
          permission: PERMISSIONS.APPLY_DISCOUNT,
        },
        {
          label: t("nav.expenses"),
          href: "/dashboard/expenses",
          enabled: true,
          icon: <NavIcon.Expenses />,
          permission: PERMISSIONS.MANAGE_EXPENSES,
        },
        {
          label: t("nav.register"),
          href: "/dashboard/register",
          enabled: true,
          icon: <NavIcon.CashRegister />,
          permission: PERMISSIONS.MANAGE_CASH_REGISTER,
        },
        {
          label: t("nav.dailyClosing"),
          href: "/dashboard/daily-closing",
          enabled: true,
          icon: <NavIcon.DailyClosing />,
          permission: PERMISSIONS.MANAGE_DAILY_CLOSING,
        },
        {
          label: t("nav.accountBooks"),
          href: "/dashboard/account-books",
          enabled: true,
          icon: <NavIcon.AccountBooks />,
          permission: PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
        },
        {
          label: t("nav.website"),
          href: "/dashboard/website",
          enabled: true,
          icon: <NavIcon.Website />,
          permission: PERMISSIONS.MANAGE_RESTAURANT_SETTINGS,
        },
        {
          // RC audit P1 fix — recordAuditLog() has been populating
          // audit_logs since Phase 2, but there was never a read path (no
          // GET endpoint, no page) — same MANAGE_STAFF trust tier as the
          // Staff nav item above, since the log surfaces exactly the kind
          // of staff-permission/role/salary changes that entry gates.
          label: t("nav.auditLog"),
          href: "/dashboard/audit-log",
          enabled: true,
          icon: <NavIcon.AuditLog />,
          permission: PERMISSIONS.MANAGE_STAFF,
        },
      ],
    },
    {
      title: t("nav.account"),
      items: [
        {
          // Gap audit P1 — restaurant-owner-facing support tickets.
          // Deliberately no `permission` here (visible to every staff
          // member, same tier as Orders/KDS above) — filing an issue with
          // the platform team shouldn't require owner/manager rank.
          label: t("nav.support"),
          href: "/dashboard/support",
          enabled: true,
          icon: <NavIcon.Support />,
        },
        {
          label: t("nav.branches"),
          href: "/dashboard/branches",
          enabled: true,
          icon: <NavIcon.Branches />,
          permission: PERMISSIONS.MANAGE_BRANCHES,
        },
        {
          label: t("nav.billing"),
          href: "/billing",
          enabled: true,
          icon: <NavIcon.Billing />,
          permission: PERMISSIONS.MANAGE_SUBSCRIPTION,
        },
        {
          label: t("nav.settings"),
          href: "/dashboard/settings",
          enabled: true,
          icon: <NavIcon.Settings />,
          permission: PERMISSIONS.MANAGE_RESTAURANT_SETTINGS,
        },
      ],
    },
  ];

  // Every item above carries the exact permission its own destination page
  // gates on server-side (see each /dashboard/*/page.tsx) — filtering here
  // is the visibility half of that same rule, so a role that can't reach a
  // page also never sees a dead-end link to it. A group that ends up with
  // no visible items (e.g. "Account" for a waiter) is dropped entirely
  // rather than rendering an empty section header.
  const NAV_GROUPS: NavGroup[] = ALL_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!item.permission) return true;
      const perms = Array.isArray(item.permission) ? item.permission : [item.permission];
      return perms.some((p) => roleHasPermission(role, p));
    }),
  })).filter((group) => group.items.length > 0);

  // Header page title — reuses ALL_NAV_GROUPS (not the role-filtered
  // NAV_GROUPS) as the single source of truth for route -> label, so a
  // page a role can't see in the sidebar still gets the right title in the
  // rare case it's reached some other way (e.g. a bookmarked URL, before
  // the destination page's own redirect kicks in). Falls back to a
  // longest-prefix match for nested routes not in the nav itself (e.g.
  // /dashboard/orders/[orderId]).
  const flatNavItems = ALL_NAV_GROUPS.flatMap((group) => group.items);
  const exactMatch = flatNavItems.find((item) => item.href === pathname);
  const prefixMatch = flatNavItems
    .filter((item) => item.href !== "#" && pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const pageTitle = exactMatch?.label ?? prefixMatch?.label ?? t("nav.dashboard");

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiPost("/api/auth/logout", {});
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  async function handleSwitchRestaurant(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextId = event.target.value;
    if (nextId === activeRestaurantId) return;
    setSwitchingRestaurant(true);
    try {
      await apiPost("/api/session/active-restaurant", { restaurantId: nextId });
    } catch {
      setSwitchingRestaurant(false);
      return;
    }
    // Caught live during QA: calling router.replace("/dashboard") and then
    // router.refresh() back-to-back — when already sitting on /dashboard —
    // fires two requests for the exact same route and the second cancels
    // the first ("The destination stream closed early." in the server
    // log), so the switch silently never showed the new restaurant's data.
    // A genuine navigation to a *different* route already re-fetches
    // fresh server data on its own (no refresh() needed); refresh() is
    // only for staying put on the current route.
    if (pathname === "/dashboard") {
      router.refresh();
      setSwitchingRestaurant(false);
    } else {
      router.push("/dashboard");
    }
  }

  // `isCollapsed` is a separate parameter from the `collapsed` state (not
  // just read from the closure) so the mobile drawer — which always calls
  // this with `false` — can't be dragged into icon-only mode by a desktop
  // rail preference persisted from a previous, wider session. The desktop
  // aside is the only caller that ties it to the real `collapsed` state.
  function navItems(onNavigate?: () => void, isCollapsed = collapsed) {
    return (
      <nav className="space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            {!isCollapsed && (
              <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                {group.title}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = item.enabled && pathname === item.href;
                const className = `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isCollapsed ? "justify-center px-2" : "justify-between"
                } ${
                  isActive
                    ? "bg-orange-50 font-medium text-orange-700"
                    : item.enabled
                      ? "font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                      : "cursor-default text-neutral-400"
                }`;

                const content = (
                  <>
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{item.icon}</span>
                      {!isCollapsed && <span className="truncate">{item.label}</span>}
                    </span>
                    {!isCollapsed && item.badge && (
                      <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
                        {item.badge}
                      </span>
                    )}
                  </>
                );

                if (item.enabled) {
                  return (
                    <Link
                      key={item.label}
                      href={item.href}
                      className={className}
                      onClick={onNavigate}
                      title={isCollapsed ? item.label : undefined}
                    >
                      {content}
                    </Link>
                  );
                }
                return (
                  <div key={item.label} className={className} title={isCollapsed ? item.label : undefined}>
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    );
  }

  // The sidebar's top brand slot — the restaurant's own logo (if set) or a
  // colored monogram, plus its name, with "Powered by RestroKendra" as a small
  // subtitle. This used to be a plain "RestroKendra" wordmark; a restaurant
  // owner living in this screen all day cares about *their own* brand, not
  // the vendor's, so the tenant's identity now leads and the platform name
  // is the small print — matching how the reference dashboard the user
  // compared us against treats its own sidebar brand slot.
  function brandBlock(isCollapsed = collapsed) {
    const monogram = monogramStyle(restaurantName);
    const logo = logoUrl ? (
      // A per-tenant data: URL or arbitrary http(s) URL isn't a
      // build-time-known asset next/image can optimize; menu item photos
      // use the same plain <img>.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full border border-neutral-100 object-cover"
      />
    ) : (
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        style={{ backgroundColor: monogram.bg, color: monogram.fg }}
        aria-hidden="true"
      >
        {initialsOf(restaurantName)}
      </span>
    );

    if (isCollapsed) return logo;

    return (
      <div className="flex min-w-0 items-center gap-2.5">
        {logo}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-neutral-900">{restaurantName}</p>
          <p className="truncate text-[11px] text-neutral-400">{t("nav.poweredBy")}</p>
          <p className="truncate text-[9px] text-neutral-300">by Saugat Thapa</p>
        </div>
      </div>
    );
  }

  function profileCard(isCollapsed = collapsed) {
    const initials =
      ownerName
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0])
        .slice(0, 2)
        .join("")
        .toUpperCase() || "?";

    return (
      <div
        className={`mt-4 rounded-xl border border-neutral-100 bg-neutral-50 p-2.5 ${
          isCollapsed ? "flex flex-col items-center gap-2" : "flex items-center gap-2.5"
        }`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-600 text-xs font-semibold text-white">
          {initials}
        </span>
        {!isCollapsed && (
          // RC audit P1 fix — the only way into /dashboard/account (change
          // password, log out other sessions), which stays separate from
          // the Settings nav item below on purpose: this is account-level
          // (any logged-in user), Settings is restaurant-level
          // (MANAGE_RESTAURANT_SETTINGS only).
          <Link href="/dashboard/account" className="min-w-0 flex-1 group">
            <p className="truncate text-sm font-medium text-neutral-900 group-hover:underline">
              {ownerName}
            </p>
            <p className="truncate text-xs capitalize text-neutral-500">{role.replace("_", " ")}</p>
          </Link>
        )}
        <button
          type="button"
          aria-label={t("nav.logOut")}
          title={t("nav.logOut")}
          onClick={handleLogout}
          disabled={loggingOut}
          className="shrink-0 rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
        >
          <NavIcon.Logout />
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-neutral-50">
      <aside
        className={`hidden shrink-0 flex-col border-r border-neutral-200 bg-white p-4 transition-[width] duration-200 md:flex ${
          collapsed ? "w-[76px]" : "w-60"
        }`}
      >
        <div className={`mb-6 flex items-center gap-2 ${collapsed ? "flex-col" : "justify-between"}`}>
          {brandBlock()}
          <button
            type="button"
            aria-label={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
            title={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            {collapsed ? <NavIcon.ChevronRight /> : <NavIcon.ChevronLeft />}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{navItems()}</div>
        {profileCard()}
      </aside>

      {/* Mobile nav drawer — md:hidden on both the trigger (in the header
          below) and this overlay, so it only ever exists below the 768px
          breakpoint where the sidebar itself is hidden. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-black/30"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white p-4 shadow-xl">
            <div className="mb-6 flex items-center justify-between px-2">
              {brandBlock(false)}
              <button
                aria-label="Close menu"
                onClick={() => setMobileNavOpen(false)}
                className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{navItems(() => setMobileNavOpen(false), false)}</div>
            {profileCard(false)}
          </div>
        </div>
      )}

      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <button
              aria-label="Open menu"
              onClick={() => setMobileNavOpen(true)}
              className="-ml-1 rounded-lg p-1.5 text-neutral-600 hover:bg-neutral-100 md:hidden"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
              </svg>
            </button>
            <div>
              <p className="text-base font-semibold text-neutral-900">{pageTitle}</p>
              <p className="text-xs text-neutral-500">{restaurantName}</p>
            </div>
          </div>

          {/* Two visually distinct clusters, separated by a divider on wide
              screens: live status info on the left, quick actions
              (notifications, Open POS) on the right — the grouping itself
              is the "clear section" the reference dashboard was missing
              when it was just one long row of same-weight pills. */}
          <div className="flex flex-wrap items-center gap-2">
            {headerStatus && (
              <div className="hidden items-center gap-2 sm:flex">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600">
                  <span className="flex h-3.5 w-3.5 items-center justify-center">
                    <NavIcon.Orders />
                  </span>
                  {headerStatus.activeOrders} active
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                    headerStatus.kitchenBusy
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-green-200 bg-green-50 text-green-700"
                  }`}
                >
                  <span className="flex h-3.5 w-3.5 items-center justify-center">
                    <NavIcon.Kitchen />
                  </span>
                  Kitchen {headerStatus.kitchenBusy ? "Busy" : "Clear"}
                </span>
              </div>
            )}
            {restaurants.length > 1 && (
              <div className="relative">
                <select
                  aria-label="Switch restaurant"
                  value={activeRestaurantId}
                  onChange={handleSwitchRestaurant}
                  disabled={switchingRestaurant}
                  className="appearance-none rounded-full border border-neutral-200 bg-white py-1.5 pl-3 pr-7 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                >
                  {restaurants.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 rotate-90 items-center text-neutral-400">
                  <NavIcon.ChevronRight />
                </span>
              </div>
            )}
            <BranchSwitcher />
            {subscriptionStatus === "trialing" && days !== null && (
              <span className="hidden rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700 sm:inline-block">
                {trialDaysLeftText(days, locale)}
              </span>
            )}

            <DateSystemToggle dateSystem={dateSystem} onChange={setDateSystem} />
            <LanguageToggle locale={locale} onChange={setLocale} label={t("nav.language")} />
            <InstallAppPrompt />

            <div className="mx-1 hidden h-6 w-px bg-neutral-200 sm:block" aria-hidden="true" />

            <NotificationBell
              status={headerStatus}
              open={notifOpen}
              onToggle={() => setNotifOpen((o) => !o)}
              onClose={() => setNotifOpen(false)}
            />

            <Link
              href="/dashboard/pos"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-orange-700 sm:px-4"
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                <NavIcon.Pos />
              </span>
              <span className="hidden sm:inline">{t("nav.openPos")}</span>
              <span className="flex h-3 w-3 items-center justify-center">
                <NavIcon.ExternalLink />
              </span>
            </Link>
          </div>
        </header>

        <DashboardServiceWorker />

        <NotificationPermissionGate slug={slug} />

        {soundBlocked && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-900 md:px-6">
            <span className="flex items-center gap-1.5">
              <span className="text-sm" aria-hidden="true">
                🔇
              </span>
              Your browser is blocking the order alert sound — you won&apos;t hear it until you enable it.
            </span>
            <button
              type="button"
              onClick={retryBlockedSound}
              className="rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700"
            >
              Tap to enable sound
            </button>
          </div>
        )}

        {pendingOrderIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-900 md:px-6">
            <span className="flex items-center gap-1.5">
              <span className="text-sm" aria-hidden="true">
                🔔
              </span>
              {pendingOrderIds.size === 1
                ? "1 new order is"
                : `${pendingOrderIds.size} new orders are`}{" "}
              waiting to be confirmed — the alert keeps playing until you do.
            </span>
            <Link
              href="/dashboard/orders"
              className="rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700"
            >
              Go to Orders
            </Link>
          </div>
        )}

        {!isOnline && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800 md:px-6">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
            You&apos;re offline — POS, Orders, and KDS will keep working and sync automatically once
            you&apos;re back online. Other pages may show stale data until then.
          </div>
        )}

        {canViewServiceCalls && activeCalls.length > 0 && (
          <div className="space-y-2 border-b border-orange-100 bg-orange-50 px-4 py-3 md:px-6">
            {activeCalls.map((call) => (
              <div
                key={call.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm ${
                      call.status === "acknowledged" ? "bg-green-50" : "animate-pulse bg-orange-100"
                    }`}
                  >
                    🔔
                  </span>
                  <span className="text-sm">
                    <span className="font-semibold text-neutral-900">{call.tableName}</span>{" "}
                    <span className="text-neutral-500">
                      {call.status === "acknowledged" ? "— on the way" : "is calling for staff"}
                    </span>
                  </span>
                </div>
                <div className="flex gap-2">
                  {call.status === "pending" && (
                    <button
                      onClick={() => actOnCall(call.id, "acknowledge")}
                      disabled={callActionBusy === call.id}
                      className="rounded-full bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      On my way
                    </button>
                  )}
                  <button
                    onClick={() => actOnCall(call.id, "resolve")}
                    disabled={callActionBusy === call.id}
                    className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50"
                  >
                    Done
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Phase 24 — the header's branch switcher, right next to the restaurant
 * switcher (same visual family, same "only render if there's more than one
 * to switch to" rule — see restaurants.length > 1 above). Reads/writes
 * BranchProvider's context directly rather than being threaded through
 * DashboardShellContent's props, so any screen under `children` (Reports
 * today) can independently read the same selection via useActiveBranch()
 * without this component needing to know who's listening.
 *
 * Unlike the restaurant switcher, changing branch does NOT navigate or
 * router.refresh() — it's a display filter, not a change of which tenant's
 * data is being requested, so screens that care (Reports) just refetch
 * their own data client-side when the context value changes.
 */
function BranchSwitcher() {
  const { branches, activeBranchId, setActiveBranchId } = useActiveBranch();
  if (branches.length <= 1) return null;

  return (
    <div className="relative">
      <select
        aria-label="Switch branch"
        value={activeBranchId ?? "__all__"}
        onChange={(e) => setActiveBranchId(e.target.value === "__all__" ? null : e.target.value)}
        className="appearance-none rounded-full border border-neutral-200 bg-white py-1.5 pl-3 pr-7 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        <option value="__all__">All branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.isMain ? " (Main)" : ""}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 rotate-90 items-center text-neutral-400">
        <NavIcon.ChevronRight />
      </span>
    </div>
  );
}

/**
 * The header's notification bell — deliberately backed by real "needs
 * attention" signals (low-stock items, reservations awaiting confirmation)
 * rather than a decorative static badge, since those counts already exist
 * elsewhere (Inventory, Reservations) and cost nothing extra to surface
 * here — see header-status/route.ts. Closes on an outside click via the
 * same fixed full-screen overlay button pattern the mobile nav drawer uses
 * above, rather than a separate click-outside hook.
 */
function NotificationBell({
  status,
  open,
  onToggle,
  onClose,
}: {
  status: HeaderStatus | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const lowStock = status?.lowStockCount ?? 0;
  const pendingReservations = status?.pendingReservationsCount ?? 0;
  const alertCount = lowStock + pendingReservations;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t("nav.notifications")}
        aria-expanded={open}
        onClick={onToggle}
        className="relative rounded-full border border-neutral-200 bg-white p-2 text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700"
      >
        <span className="flex h-4 w-4 items-center justify-center">
          <NavIcon.Bell />
        </span>
        {alertCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
            {alertCount > 9 ? "9+" : alertCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={onClose}
          />
          <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg">
            <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Needs attention
            </p>
            {alertCount === 0 ? (
              <p className="px-2 py-3 text-sm text-neutral-500">You&apos;re all caught up.</p>
            ) : (
              <div className="space-y-1">
                {lowStock > 0 && (
                  <Link
                    href="/dashboard/inventory"
                    onClick={onClose}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-neutral-50"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                      <NavIcon.AlertCircle />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-neutral-900">
                        {lowStock} item{lowStock === 1 ? "" : "s"} low on stock
                      </span>
                      <span className="block text-xs text-neutral-500">At or below reorder level</span>
                    </span>
                  </Link>
                )}
                {pendingReservations > 0 && (
                  <Link
                    href="/dashboard/reservations"
                    onClick={onClose}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-neutral-50"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                      <NavIcon.Reservations />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-neutral-900">
                        {pendingReservations} reservation{pendingReservations === 1 ? "" : "s"} awaiting
                        confirmation
                      </span>
                      <span className="block text-xs text-neutral-500">Requested, not yet confirmed</span>
                    </span>
                  </Link>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Header AD/BS calendar toggle — today's date, switchable between the
 * Nepali (Bikram Sambat) and Gregorian calendars. A `nepali-date-converter`-
 * backed label (see src/lib/nepali-date.ts) next to a two-way segmented
 * switch, styled like the notification bell's pill so the two read as one
 * family of header controls rather than one borrowed from elsewhere.
 *
 * This drives the site-wide preference (DateSystemProvider, wrapping this
 * whole shell): every dashboard screen that renders a record's date —
 * Orders, Reports, Reservations, Expenses, Account Books, Customers,
 * Staff, Inventory — calls `useDateSystem()` and `formatDate()` (see
 * src/lib/nepali-date.ts) to follow this same toggle, not just this
 * header's own label. Native `<input type="date">` filter/entry fields
 * stay Gregorian (no browser ships a BS date picker), with a small BS
 * equivalent hint shown alongside them when BS is active.
 */
/**
 * Dashboard-wide EN/नेपाली toggle — same visual pattern as DateSystemToggle
 * right next to it (a pill-group control in the header), backed by
 * LocaleProvider (src/lib/i18n.tsx) rather than DateSystemProvider. Only
 * the shell's own chrome (this file) is translated so far — see i18n.tsx's
 * module comment for the deliberately narrow initial scope; picking नेपाली
 * here does not yet change page content on Orders/POS/Reports/etc.
 */
function LanguageToggle({
  locale,
  onChange,
  label,
}: {
  locale: Locale;
  onChange: (next: Locale) => void;
  label: string;
}) {
  return (
    <div
      className="hidden items-center rounded-full bg-neutral-100 p-0.5 sm:flex"
      role="group"
      aria-label={label}
    >
      {(["en", "ne"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={locale === option}
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors ${
            locale === option
              ? "bg-white text-orange-700 shadow-sm"
              : "text-neutral-400 hover:text-neutral-600"
          }`}
        >
          {option === "en" ? "EN" : "ने"}
        </button>
      ))}
    </div>
  );
}

function DateSystemToggle({
  dateSystem,
  onChange,
}: {
  dateSystem: DateSystem;
  onChange: (next: DateSystem) => void;
}) {
  const today = new Date();
  const label = dateSystem === "BS" ? formatBsDate(today) : formatAdDate(today);

  return (
    <div className="hidden items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-3 text-xs font-medium text-neutral-600 sm:flex">
      <div className="flex items-center rounded-full bg-neutral-100 p-0.5" role="group" aria-label="Calendar system">
        {(["BS", "AD"] as const).map((system) => (
          <button
            key={system}
            type="button"
            onClick={() => onChange(system)}
            aria-pressed={dateSystem === system}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors ${
              dateSystem === system
                ? "bg-white text-orange-700 shadow-sm"
                : "text-neutral-400 hover:text-neutral-600"
            }`}
          >
            {system}
          </button>
        ))}
      </div>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-neutral-400" aria-hidden="true">
        <NavIcon.Calendar />
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}
