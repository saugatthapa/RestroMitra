"use client";

import { useEffect, useMemo, useState } from "react";
// A warm, slightly editorial serif for the restaurant's name, item names,
// and prices — the one deliberate typographic flourish on this page. Menu
// browsing is otherwise all system-sans (fast, familiar, easy to scan);
// this face is reserved for the handful of moments that should feel like
// they were designed for THIS restaurant rather than any generic app
// screen. Imported from @fontsource (the font files ship inside the npm
// package itself) rather than next/font/google, deliberately: next/font
// fetches from Google Fonts AT BUILD TIME, and a build-time network hiccup
// (this sandbox's own network policy blocks fonts.googleapis.com outright,
// and there's no guarantee every hosting environment allows it either)
// would fail `npm run build` entirely — see globals.css for the resulting
// `.font-display` class. Only the two weights actually used are imported.
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import { formatNPR } from "@/lib/money";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { MenuItemThumb } from "@/components/MenuItemThumb";
import { useGuestTranslation, cartItemCountText, type Locale, type TranslationKey } from "@/lib/i18n";

const display = { className: "font-display" };

type TFunc = (key: TranslationKey) => string;

type Variant = { id: string; name: string; priceInPaisa: number };
type Addon = { id: string; name: string; priceInPaisa: number };
type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  basePriceInPaisa: number;
  variants: Variant[];
  addons: Addon[];
};
type Category = { id: string; name: string; menuItems: MenuItem[] };

type CartLine = {
  key: string;
  menuItemId: string;
  itemName: string;
  variantId: string | null;
  variantName: string | null;
  unitPriceInPaisa: number;
  quantity: number;
  addonIds: string[];
  addonsSummary: { id: string; name: string; priceInPaisa: number }[];
  notes: string;
};

function cartLineTotal(line: CartLine): number {
  const addonUnitTotal = line.addonsSummary.reduce((sum, a) => sum + a.priceInPaisa, 0);
  return (line.unitPriceInPaisa + addonUnitTotal) * line.quantity;
}

/** EN/नेपाली toggle for a guest's own device — see useGuestTranslation's doc
 * comment in i18n.tsx for why this is a separate preference from the
 * dashboard's. Menu item/category names themselves stay whatever the
 * restaurant entered (this doesn't translate restaurant-authored content,
 * only the app's own surrounding UI text). */
function GuestLanguageToggle({ locale, onChange }: { locale: Locale; onChange: (next: Locale) => void }) {
  return (
    <div className="flex items-center rounded-full bg-black/[0.04] p-0.5 backdrop-blur-sm" role="group" aria-label="Language">
      {(["en", "ne"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={locale === option}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all ${
            locale === option ? "bg-white text-orange-700 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
          }`}
        >
          {option === "en" ? "EN" : "ने"}
        </button>
      ))}
    </div>
  );
}

/** Restaurant's logo if they've set one; otherwise a warm monogram tile in
 * the same visual family as MenuItemThumb's fallback, so a restaurant with
 * no logo yet still gets a considered, on-brand hero rather than a blank
 * space. */
function BrandMark({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!logoUrl || failed) {
    const initial = name.trim().charAt(0).toUpperCase() || "?";
    return (
      <div
        className={`${display.className} flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-600 text-2xl font-semibold text-white shadow-md shadow-orange-900/10`}
        aria-hidden="true"
      >
        {initial}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary stored URL, see MenuItemThumb's identical reasoning
    <img
      src={logoUrl}
      alt=""
      onError={() => setFailed(true)}
      className="h-14 w-14 shrink-0 rounded-2xl object-cover shadow-md shadow-orange-900/10 ring-1 ring-black/5"
    />
  );
}

export function PublicOrderMenu({
  token,
  restaurantName,
  restaurantLogoUrl,
  tableName,
  categories,
}: {
  token: string;
  restaurantName: string;
  restaurantLogoUrl?: string | null;
  tableName: string;
  categories: Category[];
}) {
  const { locale, setLocale, t } = useGuestTranslation();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    categories[0]?.id ?? null,
  );
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customizingItem, setCustomizingItem] = useState<MenuItem | null>(null);
  const [view, setView] = useState<"menu" | "cart" | "checkout" | "confirmation">("menu");
  const [confirmation, setConfirmation] = useState<{
    orderNumber: string;
    totalInPaisa: number;
  } | null>(null);

  // "Call staff" — see src/app/api/order/[token]/service-call/route.ts.
  // `callStatus` null means no active call (either never called, or a
  // previous one was resolved); "requesting" is the brief window between
  // tapping the button and the POST resolving.
  const [call, setCall] = useState<{ id: string; status: "pending" | "acknowledged" } | null>(
    null,
  );
  const [callRequesting, setCallRequesting] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  // Picks up an already-active call on page load/refresh (a guest who
  // called staff, then re-scanned or reloaded, shouldn't lose the "staff
  // have been notified" state), then short-polls while a call is active so
  // the status line advances from "notified" to "on the way" without the
  // guest having to do anything. 3s is plenty for a status a human is
  // glancing at occasionally — see the route's doc comment for why this is
  // plain polling rather than another SSE stream.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const data = await apiGet<{
          call: { id: string; status: "pending" | "acknowledged" | "resolved" } | null;
        }>(`/api/order/${token}/service-call`);
        if (cancelled) return;
        if (data.call && data.call.status !== "resolved") {
          setCall({ id: data.call.id, status: data.call.status });
        } else {
          setCall(null);
        }
      } catch {
        // ignore — a failed background poll just leaves the last known
        // state on screen, same as the header-status poll pattern used
        // elsewhere in this app.
      }
    }
    check();
    const interval = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token]);

  async function callStaff() {
    setCallRequesting(true);
    setCallError(null);
    try {
      const data = await apiPost<{ call: { id: string; status: "pending" | "acknowledged" } }>(
        `/api/order/${token}/service-call`,
        {},
      );
      setCall(data.call);
    } catch (err) {
      setCallError(err instanceof ApiError ? err.message : t("publicMenu.couldNotReachStaff"));
    } finally {
      setCallRequesting(false);
    }
  }

  const cartTotal = useMemo(() => cart.reduce((sum, l) => sum + cartLineTotal(l), 0), [cart]);
  const cartCount = useMemo(() => cart.reduce((sum, l) => sum + l.quantity, 0), [cart]);

  function addToCart(line: CartLine) {
    setCart((prev) => [...prev, line]);
    setCustomizingItem(null);
    setView("menu");
  }

  function removeCartLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  function changeQuantity(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  if (categories.length === 0) {
    return (
      <div className={`flex min-h-screen items-center justify-center bg-stone-50 p-6 text-center`}>
        <div>
          <p className={`${display.className} text-xl font-semibold text-neutral-900`}>{restaurantName}</p>
          <p className="mt-2 text-sm text-neutral-500">{t("publicMenu.menuUnavailable")}</p>
        </div>
      </div>
    );
  }

  if (view === "confirmation" && confirmation) {
    return (
      <div className={`flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-orange-50/70 via-stone-50 to-stone-50 p-6 text-center`}>
        <div className="w-full max-w-sm animate-hero-in rounded-3xl border border-stone-200/70 bg-white p-7 shadow-xl shadow-orange-900/5">
          <div className="relative mx-auto mb-4 flex h-16 w-16 items-center justify-center">
            <span className="absolute inset-0 animate-pulse-ring rounded-full bg-green-500/20" />
            <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-green-50 text-3xl text-green-600 ring-1 ring-green-100">
              ✓
            </span>
          </div>
          <p className={`${display.className} text-xl font-semibold text-neutral-900`}>
            {t("publicMenu.orderPlaced")}
          </p>
          <p className="mt-1.5 text-sm text-neutral-500">{t("publicMenu.showScreenToStaff")}</p>
          <div className="mt-5 space-y-2 rounded-2xl bg-stone-50 p-4 text-left text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-neutral-500">{t("publicMenu.orderNumberLabel")}</span>
              <span className={`${display.className} text-base font-semibold text-neutral-900`}>
                {confirmation.orderNumber}
              </span>
            </div>
            <div className="flex items-baseline justify-between border-t border-dashed border-stone-200 pt-2">
              <span className="text-neutral-500">{t("publicMenu.tableLabel")}</span>
              <span className="font-semibold text-neutral-900">{tableName}</span>
            </div>
            <div className="flex items-baseline justify-between border-t border-dashed border-stone-200 pt-2">
              <span className="text-neutral-500">{t("publicMenu.totalLabel")}</span>
              <span className={`${display.className} text-base font-semibold text-orange-700`}>
                {formatNPR(confirmation.totalInPaisa)}
              </span>
            </div>
          </div>
          <button
            className="btn-secondary mt-6 w-full rounded-full"
            onClick={() => {
              setCart([]);
              setConfirmation(null);
              setView("menu");
            }}
          >
            {t("publicMenu.orderMore")}
          </button>
        </div>
      </div>
    );
  }

  return (
    // Deliberately NOT min-h-screen — a short menu, an empty cart, or the
    // checkout form (all a few hundred px of content) used to sit inside a
    // full-viewport-height wrapper, leaving a large dead gray void below
    // everything. Letting the page be exactly as tall as its content is
    // means a customer never lands on a screen that looks broken/half-
    // loaded just because it doesn't happen to fill their phone.
    <div className={`min-h-full bg-stone-50 pb-28`}>
      <header className="sticky top-0 z-10 border-b border-stone-200/80 bg-white/90 backdrop-blur-md">
        <div className="flex items-center gap-3 px-4 pb-3 pt-4 sm:px-6">
          <BrandMark logoUrl={restaurantLogoUrl ?? null} name={restaurantName} />
          <div className="min-w-0 flex-1">
            <p className={`${display.className} truncate text-lg font-semibold leading-tight text-neutral-900`}>
              {restaurantName}
            </p>
            <p className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
              {tableName}
            </p>
          </div>
          <GuestLanguageToggle locale={locale} onChange={setLocale} />
        </div>

        <div className="flex items-center justify-between gap-2 px-4 pb-3 sm:px-6">
          {call ? (
            <span
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                call.status === "acknowledged"
                  ? "bg-green-50 text-green-700"
                  : "bg-orange-50 text-orange-700"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  call.status === "acknowledged" ? "bg-green-500" : "animate-pulse bg-orange-500"
                }`}
              />
              {call.status === "acknowledged" ? t("publicMenu.staffOnTheWay") : t("publicMenu.staffNotified")}
            </span>
          ) : (
            <button
              onClick={callStaff}
              disabled={callRequesting}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition active:scale-[0.97] active:bg-stone-50 disabled:opacity-50"
            >
              🔔 {callRequesting ? t("publicMenu.calling") : t("publicMenu.callStaff")}
            </button>
          )}
          {callError && <p className="text-[11px] text-red-600">{callError}</p>}
        </div>
      </header>

      {view === "menu" && (
        <>
          {categories.length > 1 && (
            <div className="sticky top-[92px] z-10 flex gap-2 overflow-x-auto border-b border-stone-200/80 bg-stone-50/95 px-4 py-2.5 backdrop-blur-md sm:px-6">
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedCategoryId(c.id)}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all ${
                    selectedCategoryId === c.id
                      ? "bg-neutral-900 text-white shadow-sm"
                      : "border border-stone-200 bg-white text-neutral-600 hover:border-stone-300"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-3 px-4 py-4 sm:px-6">
            {categories
              .find((c) => c.id === selectedCategoryId)
              ?.menuItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setCustomizingItem(item)}
                  className="group flex w-full items-center gap-3.5 rounded-2xl border border-stone-200/80 bg-white p-3 text-left shadow-sm shadow-stone-900/[0.03] transition-all active:scale-[0.99] active:shadow-none"
                >
                  <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="lg" rounded="rounded-xl" />
                  <div className="min-w-0 flex-1">
                    <p className={`${display.className} truncate text-[15px] font-medium text-neutral-900`}>
                      {item.name}
                    </p>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-neutral-500">
                        {item.description}
                      </p>
                    )}
                    <p className={`${display.className} mt-1.5 text-sm font-semibold text-orange-700`}>
                      {item.variants.length > 0
                        ? priceRange(item.variants)
                        : formatNPR(item.basePriceInPaisa)}
                    </p>
                  </div>
                  <span className="flex shrink-0 h-8 w-8 items-center justify-center self-center rounded-full bg-stone-100 text-base font-semibold text-neutral-700 transition-colors group-hover:bg-orange-600 group-hover:text-white group-active:bg-orange-600 group-active:text-white">
                    +
                  </span>
                </button>
              ))}
          </div>

          <p className="px-4 pb-2 pt-1 text-center text-[11px] text-neutral-400 sm:px-6">
            <a
              href="/"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-neutral-600 hover:underline"
            >
              {t("publicMenu.poweredBy")}
            </a>
          </p>
        </>
      )}

      {view === "cart" && (
        <CartView
          cart={cart}
          t={t}
          onBack={() => setView("menu")}
          onRemove={removeCartLine}
          onChangeQuantity={changeQuantity}
          onCheckout={() => setView("checkout")}
        />
      )}

      {view === "checkout" && (
        <CheckoutView
          token={token}
          cart={cart}
          total={cartTotal}
          t={t}
          onBack={() => setView("cart")}
          onPlaced={(order) => {
            setConfirmation(order);
            setView("confirmation");
          }}
        />
      )}

      {customizingItem && (
        <CustomizeModal
          item={customizingItem}
          t={t}
          onClose={() => setCustomizingItem(null)}
          onAdd={addToCart}
        />
      )}

      {view === "menu" && cartCount > 0 && (
        <button
          onClick={() => setView("cart")}
          className="fixed inset-x-4 bottom-4 z-20 flex animate-hero-in items-center justify-between rounded-2xl bg-gradient-to-r from-orange-600 to-orange-500 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-orange-900/25 transition active:scale-[0.98] sm:inset-x-auto sm:right-6 sm:w-96"
        >
          <span className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-[11px]">
              {cartCount > 9 ? "9+" : cartCount}
            </span>
            {t("publicMenu.viewCart")} · {cartItemCountText(cartCount, locale)}
          </span>
          <span className={`${display.className}`}>{formatNPR(cartTotal)}</span>
        </button>
      )}
    </div>
  );
}

function priceRange(variants: Variant[]): string {
  const prices = variants.map((v) => v.priceInPaisa);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatNPR(min) : `${formatNPR(min)} – ${formatNPR(max)}`;
}

function CustomizeModal({
  item,
  t,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  t: TFunc;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const [variantId, setVariantId] = useState<string | null>(item.variants[0]?.id ?? null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  const unitPriceInPaisa =
    item.variants.length > 0
      ? (item.variants.find((v) => v.id === variantId)?.priceInPaisa ?? item.variants[0].priceInPaisa)
      : item.basePriceInPaisa;
  const chosenAddons = item.addons.filter((a) => addonIds.includes(a.id));
  const addonUnitTotal = chosenAddons.reduce((sum, a) => sum + a.priceInPaisa, 0);
  const lineTotal = (unitPriceInPaisa + addonUnitTotal) * quantity;

  function toggleAddon(id: string) {
    setAddonIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  function handleAdd() {
    if (item.variants.length > 0 && !variantId) return;
    const selectedVariant = item.variants.find((v) => v.id === variantId) ?? null;
    onAdd({
      key: `${item.id}-${variantId ?? "base"}-${addonIds.slice().sort().join(",")}-${Date.now()}`,
      menuItemId: item.id,
      itemName: item.name,
      variantId: selectedVariant?.id ?? null,
      variantName: selectedVariant?.name ?? null,
      unitPriceInPaisa,
      quantity,
      addonIds,
      addonsSummary: chosenAddons.map((a) => ({ id: a.id, name: a.name, priceInPaisa: a.priceInPaisa })),
      notes: notes.trim(),
    });
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-neutral-900/40 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div className="max-h-[88vh] w-full max-w-md animate-hero-in overflow-y-auto rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
        {item.imageUrl ? (
          <div className="relative aspect-[16/9] w-full overflow-hidden bg-stone-50 sm:rounded-t-3xl">
            <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="fill" rounded="rounded-none" />
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/25 to-transparent" />
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm backdrop-blur-sm"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex justify-end p-4 pb-0">
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-stone-100 hover:text-neutral-700"
            >
              ✕
            </button>
          </div>
        )}

        <div className="p-5 pt-4">
          <p className={`${display.className} text-lg font-semibold text-neutral-900`}>{item.name}</p>
          {item.description && (
            <p className="mt-1 text-sm leading-relaxed text-neutral-500">{item.description}</p>
          )}

          {item.variants.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {t("publicMenu.chooseOption")}
              </p>
              <div className="space-y-1.5">
                {item.variants.map((v) => (
                  <label
                    key={v.id}
                    className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                      variantId === v.id
                        ? "border-orange-300 bg-orange-50/70"
                        : "border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="variant"
                        checked={variantId === v.id}
                        onChange={() => setVariantId(v.id)}
                        className="h-4 w-4 accent-orange-600"
                      />
                      <span className="font-medium text-neutral-800">{v.name}</span>
                    </span>
                    <span className="text-neutral-500">{formatNPR(v.priceInPaisa)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {item.addons.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {t("publicMenu.addons")}
              </p>
              <div className="space-y-1.5">
                {item.addons.map((a) => (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                      addonIds.includes(a.id)
                        ? "border-orange-300 bg-orange-50/70"
                        : "border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={addonIds.includes(a.id)}
                        onChange={() => toggleAddon(a.id)}
                        className="h-4 w-4 rounded accent-orange-600"
                      />
                      <span className="font-medium text-neutral-800">{a.name}</span>
                    </span>
                    <span className="text-neutral-500">
                      {a.priceInPaisa > 0 ? `+${formatNPR(a.priceInPaisa)}` : t("publicMenu.free")}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <textarea
            className="input mt-4 rounded-xl"
            rows={2}
            placeholder={t("publicMenu.specialInstructions")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {t("publicMenu.quantity")}
            </p>
            <div className="flex items-center gap-3 rounded-full border border-stone-200 px-1 py-1">
              <button
                className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition hover:bg-stone-100 active:scale-90"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="w-5 text-center text-sm font-semibold">{quantity}</span>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition hover:bg-stone-100 active:scale-90"
                onClick={() => setQuantity((q) => Math.min(50, q + 1))}
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={handleAdd}
            disabled={item.variants.length > 0 && !variantId}
            className="mt-5 flex w-full items-center justify-between rounded-full bg-gradient-to-r from-orange-600 to-orange-500 px-5 py-3.5 text-sm font-semibold text-white shadow-md shadow-orange-900/20 transition active:scale-[0.98] disabled:opacity-50"
          >
            <span>{t("publicMenu.addToCart")}</span>
            <span className={display.className}>{formatNPR(lineTotal)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function CartView({
  cart,
  t,
  onBack,
  onRemove,
  onChangeQuantity,
  onCheckout,
}: {
  cart: CartLine[];
  t: TFunc;
  onBack: () => void;
  onRemove: (key: string) => void;
  onChangeQuantity: (key: string, delta: number) => void;
  onCheckout: () => void;
}) {
  const total = cart.reduce((sum, l) => sum + cartLineTotal(l), 0);

  return (
    <div className="px-4 py-4 sm:px-6">
      <button onClick={onBack} className="mb-4 text-sm font-medium text-neutral-500 hover:text-neutral-800">
        {t("publicMenu.backToMenu")}
      </button>
      <h1 className={`${display.className} mb-3 text-xl font-semibold text-neutral-900`}>
        {t("publicMenu.yourOrder")}
      </h1>

      {cart.length === 0 ? (
        <p className="text-sm text-neutral-500">{t("publicMenu.cartEmpty")}</p>
      ) : (
        <div className="space-y-3">
          {cart.map((line) => (
            <div key={line.key} className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm shadow-stone-900/[0.03]">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">
                    {line.itemName}
                    {line.variantName ? ` — ${line.variantName}` : ""}
                  </p>
                  {line.addonsSummary.length > 0 && (
                    <p className="text-xs text-neutral-500">
                      {line.addonsSummary.map((a) => a.name).join(", ")}
                    </p>
                  )}
                  {line.notes && <p className="text-xs italic text-neutral-400">{line.notes}</p>}
                </div>
                <button
                  onClick={() => onRemove(line.key)}
                  className="text-xs font-medium text-neutral-400 hover:text-red-600"
                >
                  {t("publicMenu.remove")}
                </button>
              </div>
              <div className="mt-2.5 flex items-center justify-between">
                <div className="flex items-center gap-3 rounded-full border border-stone-200 px-1 py-1">
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition hover:bg-stone-100 active:scale-90"
                    onClick={() => onChangeQuantity(line.key, -1)}
                  >
                    −
                  </button>
                  <span className="w-5 text-center text-sm font-medium">{line.quantity}</span>
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition hover:bg-stone-100 active:scale-90"
                    onClick={() => onChangeQuantity(line.key, 1)}
                  >
                    +
                  </button>
                </div>
                <p className={`${display.className} text-sm font-semibold text-neutral-900`}>
                  {formatNPR(cartLineTotal(line))}
                </p>
              </div>
            </div>
          ))}

          <div className="border-t border-dashed border-stone-300 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold text-neutral-900">{t("publicMenu.subtotal")}</span>
              <span className={`${display.className} whitespace-nowrap text-base font-semibold text-neutral-900`}>
                {formatNPR(total)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-neutral-400">{t("publicMenu.taxAtCheckout")}</p>
          </div>

          <button
            onClick={onCheckout}
            className="flex w-full items-center justify-center rounded-full bg-gradient-to-r from-orange-600 to-orange-500 px-5 py-3.5 text-sm font-semibold text-white shadow-md shadow-orange-900/20 transition active:scale-[0.98]"
          >
            {t("publicMenu.checkout")}
          </button>
        </div>
      )}
    </div>
  );
}

function CheckoutView({
  token,
  cart,
  total,
  t,
  onBack,
  onPlaced,
}: {
  token: string;
  cart: CartLine[];
  total: number;
  t: TFunc;
  onBack: () => void;
  onPlaced: (order: { orderNumber: string; totalInPaisa: number }) => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // QA hardening pass (QR-order idempotency audit) — generated once per
  // mount of this checkout view (not inside handleSubmit), so it stays the
  // SAME value across a retry of the same logical submission — a double
  // tap, a network-timeout retry, or two browser tabs racing — matching
  // the identical reasoning POSOrderBuilder.tsx already uses for its own
  // clientRequestId. The backend (api/order/[token]/route.ts) already has
  // full DB-backed idempotency (a partial unique index on
  // (restaurantId, clientRequestId) plus catch-and-replay on conflict,
  // tested in route.test.ts) — this view was simply never sending the key
  // that turns that protection on, so real guest checkouts got zero
  // dedup and N simultaneous taps produced N separate orders/KOTs/pushes.
  const [clientRequestId] = useState(() => crypto.randomUUID());

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<{
        order: { orderNumber: string; totalInPaisa: number };
      }>(`/api/order/${token}`, {
        items: cart.map((l) => ({
          menuItemId: l.menuItemId,
          variantId: l.variantId,
          quantity: l.quantity,
          addonIds: l.addonIds,
          notes: l.notes || undefined,
        })),
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        notes: notes.trim(),
        clientRequestId,
      });
      onPlaced(res.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("publicMenu.couldNotPlaceOrder"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <button
        onClick={onBack}
        className="mb-4 text-sm font-medium text-neutral-500 hover:text-neutral-800"
        disabled={submitting}
      >
        {t("publicMenu.backToCart")}
      </button>
      <h1 className={`${display.className} mb-3 text-xl font-semibold text-neutral-900`}>
        {t("publicMenu.checkout")}
      </h1>

      <div className="space-y-3">
        <input
          className="input rounded-xl"
          placeholder={t("publicMenu.yourNameOptional")}
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
        />
        <input
          className="input rounded-xl"
          placeholder={t("publicMenu.phoneOptional")}
          value={customerPhone}
          onChange={(e) => setCustomerPhone(e.target.value)}
        />
        <textarea
          className="input rounded-xl"
          rows={2}
          placeholder={t("publicMenu.notesForKitchen")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="rounded-2xl bg-stone-100/80 px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold text-neutral-900">{t("publicMenu.estimatedSubtotal")}</span>
            <span className={`${display.className} whitespace-nowrap text-base font-semibold text-neutral-900`}>
              {formatNPR(total)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-neutral-500">{t("publicMenu.taxAddedOnSubmission")}</p>
        </div>

        {error && <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex w-full items-center justify-center rounded-full bg-gradient-to-r from-orange-600 to-orange-500 px-5 py-3.5 text-sm font-semibold text-white shadow-md shadow-orange-900/20 transition active:scale-[0.98] disabled:opacity-60"
        >
          {submitting ? t("publicMenu.placingOrder") : t("publicMenu.placeOrder")}
        </button>
      </div>
    </div>
  );
}
