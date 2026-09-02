import { NavIcon } from "@/components/NavIcon";
import { AuthIcon } from "./AuthIcons";

// Real features only — no fabricated "30+ restaurants" / "4.9 rating"
// social-proof numbers, since RestroKendra doesn't have that track record yet
// and a made-up stat is worse than no stat once someone checks. Everything
// here (the feature list, the 30-day/no-card/cancel-anytime trio, the
// preview's chrome) matches what the product and the register API
// actually do.
const FEATURES: { icon: React.ReactNode; label: string }[] = [
  { icon: <NavIcon.Orders />, label: "Orders & KOT" },
  { icon: <NavIcon.Pos />, label: "POS" },
  { icon: <NavIcon.Kitchen />, label: "Kitchen display" },
  { icon: <NavIcon.AccountBooks />, label: "Account books" },
  { icon: <NavIcon.Inventory />, label: "Inventory" },
  { icon: <NavIcon.Assistant />, label: "AI assistant" },
  { icon: <NavIcon.Website />, label: "Your own website" },
];

const TRUST_ITEMS = ["30-day free trial", "No card required", "Cancel anytime"];

/**
 * Right-hand marketing panel for the split-screen auth layout (hidden
 * below `lg`, see (auth)/layout.tsx). A static, illustrative miniature of
 * the real dashboard chrome — same sidebar/header/stat-tile shapes and
 * colors as DashboardShell/StatTile — rather than a screenshot, so it
 * never goes stale as the real UI evolves and never has to fake data to
 * look populated.
 */
export function AuthMarketingPanel() {
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden bg-gradient-to-br from-orange-600 via-orange-600 to-orange-800 p-10 text-white xl:p-14">
      {/* Decorative background glow — purely visual, no content */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-surface-2/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-black/10 blur-3xl"
      />

      <div className="relative">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2/15 px-3 py-1 text-xs font-medium backdrop-blur-sm">
          <AuthIcon.Sparkle />
          Built for restaurants in Nepal
        </span>

        <h2 className="mt-5 max-w-md text-2xl font-semibold leading-snug xl:text-3xl">
          Everything your restaurant needs, in one screen.
        </h2>
        <p className="mt-3 max-w-md text-sm text-orange-50/90">
          Orders, kitchen display, billing, inventory, loyalty, AI insights, and your own
          ordering website — no juggling six different apps to run one restaurant.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {FEATURES.map((f) => (
            <span
              key={f.label}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-2/10 px-3 py-1.5 text-xs font-medium backdrop-blur-sm"
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center opacity-90">{f.icon}</span>
              {f.label}
            </span>
          ))}
        </div>
      </div>

      {/* Product preview card — a miniature of the real dashboard chrome */}
      <div className="relative mt-8 hidden rounded-2xl bg-surface-2 p-3 text-ink shadow-2xl ring-1 ring-black/5 xl:block">
        <div className="mb-3 flex items-center gap-1.5 px-1">
          <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-300" />
          <span className="ml-2 text-[11px] font-medium text-ink-faint">
            RestroKendra — Dashboard
          </span>
        </div>
        <div className="flex gap-3">
          <div className="flex w-9 flex-col items-center gap-2.5 rounded-xl bg-surface-1 py-3">
            {[NavIcon.Dashboard, NavIcon.Orders, NavIcon.Pos, NavIcon.Reports, NavIcon.Menu].map(
              (Icon, i) => (
                <span
                  key={i}
                  className={`flex h-6 w-6 items-center justify-center rounded-md ${
                    i === 0 ? "bg-orange-500/20 text-orange-400" : "text-ink-faint"
                  }`}
                >
                  <Icon />
                </span>
              ),
            )}
          </div>
          <div className="flex-1 space-y-2.5">
            <div className="flex items-center justify-between rounded-lg border border-hairline/60 px-2.5 py-1.5">
              <span className="text-[11px] font-semibold text-ink-secondary">Cafe Pink Floyd</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                <span className="flex h-2.5 w-2.5 items-center justify-center">
                  <NavIcon.Pos />
                </span>
                Open POS
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: <NavIcon.Orders />, label: "Orders" },
                { icon: <NavIcon.Reports />, label: "Revenue" },
                { icon: <NavIcon.Tables />, label: "Tables" },
              ].map((tile) => (
                <div key={tile.label} className="rounded-lg bg-surface-1 px-2 py-1.5">
                  <span className="flex h-4 w-4 items-center justify-center text-orange-500">
                    {tile.icon}
                  </span>
                  <p className="mt-1 text-[9px] font-medium text-ink-faint">{tile.label}</p>
                </div>
              ))}
            </div>
            <svg viewBox="0 0 200 46" className="h-11 w-full" preserveAspectRatio="none">
              <path
                d="M0 36 L28 30 L56 34 L84 16 L112 22 L140 8 L168 18 L200 4"
                fill="none"
                stroke="#eb6834"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M0 40 L28 38 L56 39 L84 30 L112 32 L140 24 L168 28 L200 20"
                fill="none"
                stroke="#2a78d6"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.55}
              />
            </svg>
          </div>
        </div>
      </div>

      <div className="relative mt-8 flex flex-wrap gap-x-5 gap-y-2 border-t border-white/15 pt-5 text-xs text-orange-50/90">
        {TRUST_ITEMS.map((item) => (
          <span key={item} className="inline-flex items-center gap-1.5">
            <span className="flex h-3.5 w-3.5 items-center justify-center">
              <AuthIcon.Check />
            </span>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
