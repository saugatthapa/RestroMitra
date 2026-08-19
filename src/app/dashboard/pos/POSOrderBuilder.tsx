"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatNPR } from "@/lib/money";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { computeOrderTotals, type DiscountType } from "@/lib/order-adjustments";
import { resolveLoyaltyRedemption } from "@/lib/loyalty-redemption";
import { MenuItemThumb } from "@/components/MenuItemThumb";
import {
  enqueueOrder,
  listQueuedOrders,
  syncQueuedOrders,
  removeQueuedOrder,
  isOfflineQueueSupported,
  type QueuedOrder,
} from "@/lib/offline-queue";
import { useOnlineStatus } from "@/lib/use-online-status";

type Variant = { id: string; name: string; priceInPaisa: number; isActive: boolean };
type Addon = { id: string; name: string; priceInPaisa: number; isAvailable: boolean };
type MenuItem = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  basePriceInPaisa: number;
  isActive: boolean;
  isAvailable: boolean;
  variants: Variant[];
  addons: Addon[];
};
type Category = { id: string; name: string };
type Table = { id: string; name: string; isActive: boolean };
type LoyaltyCustomer = { id: string; fullName: string; phone: string; loyaltyPointsBalance: number };

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

type MenuSnapshot = {
  categories: Category[];
  menuItems: MenuItem[];
  tables: Table[];
  cachedAt: string;
};

function cartLineTotal(line: CartLine): number {
  const addonUnitTotal = line.addonsSummary.reduce((sum, a) => sum + a.priceInPaisa, 0);
  return (line.unitPriceInPaisa + addonUnitTotal) * line.quantity;
}

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

// Phase 11b (offline POS): the POS page's own menu/table data is cached to
// localStorage every time it loads successfully, so a device that goes
// offline (or reloads while offline — the dashboard-wide service worker at
// public/dashboard-sw.js, Phase 22, keeps the page shell itself available)
// can still render a usable, if possibly stale, ordering screen instead of
// a blank error.
function snapshotKey(slug: string) {
  return `dhankipos:pos-menu:${slug}`;
}

function readSnapshot(slug: string): MenuSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(snapshotKey(slug));
    if (!raw) return null;
    return JSON.parse(raw) as MenuSnapshot;
  } catch {
    return null;
  }
}

function writeSnapshot(slug: string, snapshot: MenuSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(snapshotKey(slug), JSON.stringify(snapshot));
  } catch {
    // Storage full/unavailable (private browsing, etc.) — offline caching is
    // a nice-to-have, never worth failing the page over.
  }
}

export function POSOrderBuilder({
  slug,
  canApplyDiscount,
  canManageCustomers,
}: {
  slug: string;
  canApplyDiscount: boolean;
  canManageCustomers: boolean;
}) {
  const router = useRouter();
  // Phase 12c: the floor plan's "Open in POS" button links here with
  // ?table=<id> so staff land straight in a dine-in order for that table
  // instead of re-selecting it from the dropdown.
  const searchParams = useSearchParams();
  const preselectedTableId = searchParams.get("table");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usingCachedMenu, setUsingCachedMenu] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [customizingItem, setCustomizingItem] = useState<MenuItem | null>(null);

  const [orderType, setOrderType] = useState<"dine_in" | "takeaway">("takeaway");
  const [tableId, setTableId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");
  // Phase 13 — discount/service charge inputs, only rendered/sent when
  // canApplyDiscount is true (mirrors APPLY_DISCOUNT gating on the backend;
  // the field is simply never shown to a role that can't use it, rather
  // than shown-then-rejected).
  const [discountType, setDiscountType] = useState<DiscountType | "none">("none");
  const [discountPercentInput, setDiscountPercentInput] = useState("");
  const [discountFlatInput, setDiscountFlatInput] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [serviceChargePercentInput, setServiceChargePercentInput] = useState("");
  // Phase 17 — attach an existing CRM customer to redeem their loyalty
  // points as a discount at checkout, only rendered when canManageCustomers
  // is true (mirrors MANAGE_CUSTOMERS gating on the backend, same pattern
  // as canApplyDiscount above).
  const [loyaltyCustomer, setLoyaltyCustomer] = useState<LoyaltyCustomer | null>(null);
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [customerSearchResults, setCustomerSearchResults] = useState<LoyaltyCustomer[]>([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [redeemPointsInput, setRedeemPointsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);

  const [queuedOrders, setQueuedOrders] = useState<QueuedOrder[]>([]);
  const [syncing, setSyncing] = useState(false);

  const refreshQueue = useCallback(async () => {
    if (!isOfflineQueueSupported()) return;
    const rows = await listQueuedOrders(slug);
    setQueuedOrders(rows);
  }, [slug]);

  const runSync = useCallback(async () => {
    if (!isOfflineQueueSupported() || syncing) return;
    setSyncing(true);
    try {
      await syncQueuedOrders(slug, async (payload) => {
        await apiPost(`${base(slug)}/orders`, payload);
      });
    } finally {
      await refreshQueue();
      setSyncing(false);
    }
  }, [slug, syncing, refreshQueue]);

  // Phase 22 (offline mode) — shared with OrdersBoard/KDSBoard now, see
  // use-online-status.ts. `runSync` fires the instant the browser reports
  // "online" again — a device regaining signal is exactly when queued
  // orders should try to land, without staff having to remember a manual
  // "Sync now" click.
  const isOnline = useOnlineStatus(runSync);

  // QA hardening pass: a queued order that keeps failing for a real reason
  // (e.g. a menu item it references was deleted while offline, so every
  // retry gets a permanent 400, not a transient network error) used to
  // retry forever with no way for staff to clear it short of clearing
  // browser storage. This is a deliberate, staff-initiated, DESTRUCTIVE
  // action — the order's details are lost, not just its "queued" status —
  // so it's confirmed and only ever offered once a sync attempt has
  // actually failed (never on a plain "waiting to go online" order).
  async function discardQueuedOrder(order: QueuedOrder) {
    const ok = window.confirm(
      `Discard this queued order (${order.summary.itemCount} item${order.summary.itemCount === 1 ? "" : "s"}, ${order.summary.totalLabel})? This cannot be undone — it will NOT be submitted.`,
    );
    if (!ok) return;
    await removeQueuedOrder(order.clientRequestId);
    await refreshQueue();
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [categoriesRes, itemsRes, tablesRes] = await Promise.all([
          apiGet<{ categories: Category[] }>(`${base(slug)}/categories`),
          apiGet<{ menuItems: MenuItem[] }>(`${base(slug)}/menu-items`),
          apiGet<{ tables: Table[] }>(`${base(slug)}/tables`),
        ]);
        if (cancelled) return;
        const activeItems = itemsRes.menuItems.filter((i) => i.isActive && i.isAvailable);
        const activeTables = tablesRes.tables.filter((t) => t.isActive);
        setCategories(categoriesRes.categories);
        setMenuItems(activeItems);
        setTables(activeTables);
        setSelectedCategoryId(categoriesRes.categories[0]?.id ?? null);
        setUsingCachedMenu(false);
        if (preselectedTableId && activeTables.some((t) => t.id === preselectedTableId)) {
          setOrderType("dine_in");
          setTableId(preselectedTableId);
        }
        writeSnapshot(slug, {
          categories: categoriesRes.categories,
          menuItems: activeItems,
          tables: activeTables,
          cachedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (cancelled) return;
        // A network-level failure (offline, DNS, timeout) never even
        // reaches the server, so it surfaces as something other than
        // ApiError — that's the signal to fall back to the last-known-good
        // snapshot instead of showing a hard error.
        const cached = err instanceof ApiError ? null : readSnapshot(slug);
        if (cached) {
          setCategories(cached.categories);
          setMenuItems(cached.menuItems);
          setTables(cached.tables);
          setSelectedCategoryId(cached.categories[0]?.id ?? null);
          setUsingCachedMenu(true);
        } else {
          setLoadError(err instanceof ApiError ? err.message : "Could not load the menu.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    refreshQueue();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Debounced CRM customer search (name or phone) — same /customers?q=
  // endpoint the Customers page itself uses. Only fires once a loyalty
  // customer isn't already attached and the query is long enough to be a
  // meaningful search, not on every keystroke of a 1-character query.
  useEffect(() => {
    if (!canManageCustomers || loyaltyCustomer) return;
    const query = customerSearchQuery.trim();
    if (query.length < 2) {
      // Sync search UI state back to "empty" once the query is too short to
      // search on — same "sync-from-effect is the actual intent here"
      // reasoning as the refreshQueue() call above.
      setCustomerSearchResults([]);
      setCustomerSearching(false);
      return;
    }
    let cancelled = false;
    setCustomerSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await apiGet<{ customers: LoyaltyCustomer[] }>(
          `${base(slug)}/customers?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled) setCustomerSearchResults(res.customers);
      } catch {
        if (!cancelled) setCustomerSearchResults([]);
      } finally {
        if (!cancelled) setCustomerSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, customerSearchQuery, canManageCustomers, loyaltyCustomer]);

  const itemsInCategory = useMemo(
    () => menuItems.filter((i) => i.categoryId === selectedCategoryId),
    [menuItems, selectedCategoryId],
  );
  const cartTotal = useMemo(() => cart.reduce((sum, l) => sum + cartLineTotal(l), 0), [cart]);
  const cartCount = useMemo(() => cart.reduce((sum, l) => sum + l.quantity, 0), [cart]);

  // cartTotal above is computed the exact same way computeOrderPricing()
  // derives subtotalInPaisa server-side (unit price + addons, × quantity,
  // summed) — so it's safe to preview against here. Tax is NOT known
  // client-side (it depends on each item's tax rate, only resolved
  // server-side), so the live preview below is explicitly labeled as
  // excluding tax rather than presenting a number that looks final but
  // isn't.
  const discountPercent = discountType === "percentage" ? Number(discountPercentInput) || 0 : 0;
  const discountFlatRupees = discountType === "flat" ? Number(discountFlatInput) || 0 : 0;
  const serviceChargePercent = Number(serviceChargePercentInput) || 0;
  const redeemPointsRequested = Math.max(0, Math.floor(Number(redeemPointsInput) || 0));
  // Live preview of what the redemption will actually clamp to — same pure
  // calc the server uses (loyalty-redemption.ts), so this never promises a
  // point value the checkout call would then reject or silently shrink.
  const loyaltyRedemptionPreview = useMemo(
    () =>
      loyaltyCustomer
        ? resolveLoyaltyRedemption({
            requestedPoints: redeemPointsRequested,
            customerPointsBalance: loyaltyCustomer.loyaltyPointsBalance,
            subtotalInPaisa: cartTotal,
          })
        : { pointsToRedeem: 0, redemptionValueInPaisa: 0 },
    [loyaltyCustomer, redeemPointsRequested, cartTotal],
  );
  const loyaltyDiscountActive = loyaltyRedemptionPreview.pointsToRedeem > 0;
  const adjustmentsPreview = useMemo(
    () =>
      computeOrderTotals({
        subtotalInPaisa: cartTotal,
        taxInPaisa: 0,
        discountType: loyaltyDiscountActive ? "flat" : discountType === "none" ? null : discountType,
        discountValue: loyaltyDiscountActive
          ? loyaltyRedemptionPreview.redemptionValueInPaisa
          : discountType === "percentage"
            ? Math.round(discountPercent * 100)
            : discountType === "flat"
              ? Math.round(discountFlatRupees * 100)
              : null,
        serviceChargeBasisPoints: Math.round(serviceChargePercent * 100),
      }),
    [
      cartTotal,
      discountType,
      discountPercent,
      discountFlatRupees,
      serviceChargePercent,
      loyaltyDiscountActive,
      loyaltyRedemptionPreview,
    ],
  );
  const hasAdjustments =
    canApplyDiscount &&
    !loyaltyDiscountActive &&
    (discountType !== "none" || serviceChargePercent > 0);
  // Service charge is independent of the discount slot (see
  // order-adjustments.ts), so it still needs to reach the server even while
  // loyalty redemption owns the discount slot — hasAdjustments above is
  // deliberately more conservative (it also gates the manual discount UI),
  // so this is checked separately for the payload.
  const hasServiceChargeOnly =
    canApplyDiscount && loyaltyDiscountActive && serviceChargePercent > 0;

  function addToCart(line: CartLine) {
    setCart((prev) => [...prev, line]);
    setCustomizingItem(null);
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

  function resetOrder() {
    setCart([]);
    setCustomerName("");
    setCustomerPhone("");
    setNotes("");
    setOrderType("takeaway");
    setTableId(null);
    setSubmitError(null);
    setDiscountType("none");
    setDiscountPercentInput("");
    setDiscountFlatInput("");
    setDiscountReason("");
    setServiceChargePercentInput("");
    setLoyaltyCustomer(null);
    setCustomerSearchQuery("");
    setCustomerSearchResults([]);
    setShowCustomerSearch(false);
    setRedeemPointsInput("");
  }

  async function handleSubmit() {
    if (cart.length === 0) return;
    if (orderType === "dine_in" && !tableId) {
      setSubmitError("Choose a table for a dine-in order.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setQueuedMessage(null);

    // Attached to every submission (not just offline ones) so a retry after
    // a genuinely ambiguous failure — e.g. the request reached the server
    // and committed, but the response never made it back — can't create a
    // second order. See the clientRequestId comment on the orders schema.
    const clientRequestId = crypto.randomUUID();
    const payload = {
      tableId: orderType === "dine_in" ? tableId : null,
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
      ...(loyaltyCustomer ? { customerId: loyaltyCustomer.id } : {}),
      ...(hasAdjustments
        ? {
            adjustments: {
              discountType: discountType === "none" ? undefined : discountType,
              discountPercent: discountType === "percentage" ? discountPercent : undefined,
              discountFlatAmount: discountType === "flat" ? discountFlatRupees : undefined,
              discountReason: discountReason.trim() || undefined,
              serviceChargePercent,
            },
          }
        : hasServiceChargeOnly
          ? { adjustments: { serviceChargePercent } }
          : {}),
      ...(loyaltyDiscountActive
        ? { loyaltyRedemption: { points: loyaltyRedemptionPreview.pointsToRedeem } }
        : {}),
    };

    async function queueForLater() {
      if (!isOfflineQueueSupported()) {
        setSubmitError(
          "You're offline and this browser doesn't support saving orders for later — connect to the internet and try again.",
        );
        return;
      }
      await enqueueOrder(slug, clientRequestId, payload, {
        itemCount: cartCount,
        totalLabel: formatNPR(cartTotal),
      });
      resetOrder();
      await refreshQueue();
      setQueuedMessage("Saved — this order will submit automatically once you're back online.");
    }

    try {
      if (!isOnline) {
        await queueForLater();
        return;
      }
      const res = await apiPost<{ order: { id: string; orderNumber: string; totalInPaisa: number } }>(
        `${base(slug)}/orders`,
        payload,
      );
      resetOrder();
      router.push(`/dashboard/orders/${res.order.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        // A real response came back (validation error, permission error,
        // etc.) — that's not a connectivity problem, so it's a genuine
        // error the staff member needs to see and fix, not something to
        // silently queue.
        setSubmitError(err.message);
      } else {
        // fetch() itself threw — offline, DNS failure, timeout — even
        // though navigator.onLine said we were connected. Queue it exactly
        // like the explicit offline path above.
        await queueForLater();
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading menu…</p>;
  }

  if (loadError) {
    return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>;
  }

  if (categories.length === 0 || menuItems.length === 0) {
    return (
      <p className="rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
        No orderable menu items yet — add some from the Menu page first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!isOnline && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          You&apos;re offline — new orders will be saved on this device and submitted
          automatically once you&apos;re back online.
        </div>
      )}
      {usingCachedMenu && (
        <div className="rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600">
          Showing the menu from your last sync — couldn&apos;t reach the server just now.
        </div>
      )}
      {queuedOrders.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-amber-800">
              {queuedOrders.length} order{queuedOrders.length === 1 ? "" : "s"} waiting to sync
            </p>
            <button
              onClick={runSync}
              disabled={!isOnline || syncing}
              className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {queuedOrders.map((o) => (
              <li key={o.clientRequestId} className="flex items-center justify-between gap-2 text-xs text-amber-700">
                <span>
                  {o.summary.itemCount} item{o.summary.itemCount === 1 ? "" : "s"} ·{" "}
                  {o.summary.totalLabel}
                </span>
                <span className="flex items-center gap-2">
                  <span className={o.status === "error" ? "font-medium text-red-600" : ""}>
                    {o.status === "error" ? `Sync failed — will retry` : "Waiting"}
                  </span>
                  {o.status === "error" && (
                    <button
                      onClick={() => discardQueuedOrder(o)}
                      className="rounded border border-red-300 px-1.5 py-0.5 font-medium text-red-700 hover:bg-red-50"
                    >
                      Discard
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {queuedMessage && (
        <p className="rounded-lg bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
          {queuedMessage}
        </p>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCategoryId(c.id)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${
                  selectedCategoryId === c.id
                    ? "border-orange-600 bg-orange-50 font-medium text-orange-700"
                    : "border-neutral-200 text-neutral-600"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>

          {itemsInCategory.length === 0 ? (
            <p className="text-sm text-neutral-400">No items in this category.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {itemsInCategory.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setCustomizingItem(item)}
                  className="overflow-hidden rounded-xl border border-neutral-200 bg-white text-left shadow-sm transition hover:border-orange-300 hover:shadow-md"
                >
                  <div className="aspect-square w-full bg-neutral-50">
                    <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="fill" rounded="rounded-none" />
                  </div>
                  <div className="p-3">
                    <p className="line-clamp-1 text-sm font-semibold text-neutral-900">{item.name}</p>
                    <p className="mt-1 text-xs font-medium text-orange-700">
                      {item.variants.filter((v) => v.isActive).length > 0
                        ? priceRange(item.variants.filter((v) => v.isActive))
                        : formatNPR(item.basePriceInPaisa)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-full shrink-0 lg:w-80">
          <div className="rounded-2xl border border-neutral-200 bg-white p-4">
            <p className="mb-3 text-sm font-semibold text-neutral-900">Current order</p>

            <div className="mb-3 flex gap-2">
              <button
                onClick={() => {
                  setOrderType("takeaway");
                  setTableId(null);
                }}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
                  orderType === "takeaway"
                    ? "border-orange-600 bg-orange-50 text-orange-700"
                    : "border-neutral-200 text-neutral-500"
                }`}
              >
                Takeaway
              </button>
              <button
                onClick={() => setOrderType("dine_in")}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
                  orderType === "dine_in"
                    ? "border-orange-600 bg-orange-50 text-orange-700"
                    : "border-neutral-200 text-neutral-500"
                }`}
              >
                Dine-in
              </button>
            </div>

            {orderType === "dine_in" && (
              <select
                className="input mb-3"
                value={tableId ?? ""}
                onChange={(e) => setTableId(e.target.value || null)}
              >
                <option value="">Choose a table…</option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            {cart.length === 0 ? (
              <p className="text-sm text-neutral-400">No items added yet.</p>
            ) : (
              <div className="mb-3 max-h-80 space-y-2 overflow-y-auto">
                {cart.map((line) => (
                  <div key={line.key} className="rounded-lg border border-neutral-200 p-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-neutral-900">
                          {line.itemName}
                          {line.variantName ? ` — ${line.variantName}` : ""}
                        </p>
                        {line.addonsSummary.length > 0 && (
                          <p className="text-neutral-500">
                            {line.addonsSummary.map((a) => a.name).join(", ")}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => removeCartLine(line.key)}
                        className="shrink-0 text-neutral-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          className="h-6 w-6 rounded-full border border-neutral-300"
                          onClick={() => changeQuantity(line.key, -1)}
                        >
                          −
                        </button>
                        <span className="w-4 text-center">{line.quantity}</span>
                        <button
                          className="h-6 w-6 rounded-full border border-neutral-300"
                          onClick={() => changeQuantity(line.key, 1)}
                        >
                          +
                        </button>
                      </div>
                      <span className="font-semibold text-neutral-900">
                        {formatNPR(cartLineTotal(line))}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mb-3 space-y-2">
              <input
                className="input"
                placeholder="Customer name (optional)"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
              <input
                className="input"
                placeholder="Phone (optional)"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
              <textarea
                className="input"
                rows={2}
                placeholder="Kitchen notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {canManageCustomers && (
              <div className="mb-3 rounded-lg border border-neutral-200 p-2.5">
                <p className="mb-2 text-xs font-semibold text-neutral-700">
                  Loyalty customer (optional)
                </p>
                {loyaltyCustomer ? (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-neutral-900">
                          {loyaltyCustomer.fullName || loyaltyCustomer.phone}
                        </p>
                        <p className="text-xs text-neutral-500">
                          {loyaltyCustomer.phone} · {loyaltyCustomer.loyaltyPointsBalance} pts
                          available
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setLoyaltyCustomer(null);
                          setRedeemPointsInput("");
                        }}
                        className="shrink-0 text-xs font-medium text-neutral-400 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                    {loyaltyCustomer.loyaltyPointsBalance > 0 && (
                      <div className="mt-2 border-t border-neutral-100 pt-2">
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={loyaltyCustomer.loyaltyPointsBalance}
                          step={1}
                          placeholder="Points to redeem"
                          value={redeemPointsInput}
                          disabled={discountType !== "none"}
                          onChange={(e) => setRedeemPointsInput(e.target.value)}
                        />
                        {discountType !== "none" ? (
                          <p className="mt-1 text-[11px] text-amber-600">
                            Clear the manual discount below to redeem points instead.
                          </p>
                        ) : (
                          redeemPointsRequested > 0 && (
                            <p className="mt-1 text-[11px] text-neutral-500">
                              {loyaltyRedemptionPreview.pointsToRedeem > 0
                                ? `Redeeming ${loyaltyRedemptionPreview.pointsToRedeem} point${loyaltyRedemptionPreview.pointsToRedeem === 1 ? "" : "s"} for ${formatNPR(loyaltyRedemptionPreview.redemptionValueInPaisa)} off.`
                                : "Add items to the cart to redeem points against."}
                            </p>
                          )
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <input
                      className="input"
                      placeholder="Search by name or phone…"
                      value={customerSearchQuery}
                      onChange={(e) => {
                        setCustomerSearchQuery(e.target.value);
                        setShowCustomerSearch(true);
                      }}
                    />
                    {customerSearching && (
                      <p className="mt-1 text-xs text-neutral-400">Searching…</p>
                    )}
                    {showCustomerSearch && customerSearchResults.length > 0 && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-neutral-200">
                        {customerSearchResults.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setLoyaltyCustomer(c);
                              setCustomerName(c.fullName);
                              setCustomerPhone(c.phone);
                              setCustomerSearchQuery("");
                              setCustomerSearchResults([]);
                              setShowCustomerSearch(false);
                            }}
                            className="block w-full px-2.5 py-1.5 text-left text-xs hover:bg-neutral-50"
                          >
                            <span className="font-medium text-neutral-900">
                              {c.fullName || "Unnamed"}
                            </span>
                            <span className="ml-1.5 text-neutral-500">
                              {c.phone} · {c.loyaltyPointsBalance} pts
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {showCustomerSearch &&
                      !customerSearching &&
                      customerSearchQuery.trim().length >= 2 &&
                      customerSearchResults.length === 0 && (
                        <p className="mt-1 text-xs text-neutral-400">
                          No matching customer found.
                        </p>
                      )}
                  </div>
                )}
              </div>
            )}

            {canApplyDiscount && (
              <div
                className={`mb-3 rounded-lg border p-2.5 ${
                  loyaltyDiscountActive
                    ? "border-neutral-100 opacity-50"
                    : "border-neutral-200"
                }`}
              >
                <p className="mb-2 text-xs font-semibold text-neutral-700">
                  Discount / service charge
                </p>
                {loyaltyDiscountActive && (
                  <p className="mb-2 text-[11px] text-neutral-500">
                    Discount is disabled while redeeming loyalty points above (service charge
                    still applies).
                  </p>
                )}
                <div className="mb-2 flex gap-1.5">
                  {(["none", "percentage", "flat"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      disabled={loyaltyDiscountActive}
                      onClick={() => setDiscountType(t)}
                      className={`flex-1 rounded-lg border px-2 py-1 text-xs font-medium ${
                        discountType === t
                          ? "border-orange-600 bg-orange-50 text-orange-700"
                          : "border-neutral-200 text-neutral-500"
                      }`}
                    >
                      {t === "none" ? "No discount" : t === "percentage" ? "% off" : "Flat Rs. off"}
                    </button>
                  ))}
                </div>
                {discountType === "percentage" && (
                  <input
                    className="input mb-2"
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    placeholder="Discount %"
                    value={discountPercentInput}
                    disabled={loyaltyDiscountActive}
                    onChange={(e) => setDiscountPercentInput(e.target.value)}
                  />
                )}
                {discountType === "flat" && (
                  <input
                    className="input mb-2"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Discount amount (Rs.)"
                    value={discountFlatInput}
                    disabled={loyaltyDiscountActive}
                    onChange={(e) => setDiscountFlatInput(e.target.value)}
                  />
                )}
                {discountType !== "none" && (
                  <input
                    className="input mb-2"
                    placeholder="Reason (optional)"
                    value={discountReason}
                    disabled={loyaltyDiscountActive}
                    onChange={(e) => setDiscountReason(e.target.value)}
                  />
                )}
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  placeholder="Service charge % (optional)"
                  value={serviceChargePercentInput}
                  onChange={(e) => setServiceChargePercentInput(e.target.value)}
                />
              </div>
            )}

            <div className="mb-3 space-y-1 border-t border-neutral-200 pt-2 text-sm text-neutral-700">
              <div className="flex items-center justify-between">
                <span>Subtotal · {cartCount} item{cartCount === 1 ? "" : "s"}</span>
                <span>{formatNPR(cartTotal)}</span>
              </div>
              {adjustmentsPreview.discountInPaisa > 0 && (
                <div className="flex items-center justify-between text-red-700">
                  <span>
                    {loyaltyDiscountActive
                      ? `Loyalty points redeemed (${loyaltyRedemptionPreview.pointsToRedeem})`
                      : "Discount"}
                  </span>
                  <span>−{formatNPR(adjustmentsPreview.discountInPaisa)}</span>
                </div>
              )}
              {adjustmentsPreview.serviceChargeInPaisa > 0 && (
                <div className="flex items-center justify-between">
                  <span>Service charge</span>
                  <span>+{formatNPR(adjustmentsPreview.serviceChargeInPaisa)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm font-semibold text-neutral-900">
                <span>Estimated total</span>
                <span>{formatNPR(adjustmentsPreview.totalInPaisa)}</span>
              </div>
              <p className="text-[11px] text-neutral-400">
                Excludes tax — the final total (with applicable tax) is calculated at checkout.
              </p>
            </div>

            {submitError && (
              <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {submitError}
              </p>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting || cart.length === 0}
              className="btn-primary w-full"
            >
              {submitting
                ? "Placing order…"
                : isOnline
                  ? "Place order"
                  : "Save order (offline)"}
            </button>
          </div>
        </div>
      </div>

      {customizingItem && (
        <CustomizeModal
          item={customizingItem}
          onClose={() => setCustomizingItem(null)}
          onAdd={addToCart}
        />
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
  onClose,
  onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const activeVariants = item.variants.filter((v) => v.isActive);
  const availableAddons = item.addons.filter((a) => a.isAvailable);
  const [variantId, setVariantId] = useState<string | null>(activeVariants[0]?.id ?? null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  const unitPriceInPaisa =
    activeVariants.length > 0
      ? (activeVariants.find((v) => v.id === variantId)?.priceInPaisa ?? activeVariants[0].priceInPaisa)
      : item.basePriceInPaisa;
  const chosenAddons = availableAddons.filter((a) => addonIds.includes(a.id));
  const addonUnitTotal = chosenAddons.reduce((sum, a) => sum + a.priceInPaisa, 0);
  const lineTotal = (unitPriceInPaisa + addonUnitTotal) * quantity;

  function toggleAddon(id: string) {
    setAddonIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  function handleAdd() {
    if (activeVariants.length > 0 && !variantId) return;
    const selectedVariant = activeVariants.find((v) => v.id === variantId) ?? null;
    onAdd({
      key: `${item.id}-${variantId ?? "base"}-${addonIds.slice().sort().join(",")}-${crypto.randomUUID()}`,
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
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="md" />
            <div className="min-w-0">
              <p className="text-base font-semibold text-neutral-900">{item.name}</p>
              {item.description && (
                <p className="mt-0.5 text-xs text-neutral-500">{item.description}</p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 text-neutral-400 hover:text-neutral-700">
            ✕
          </button>
        </div>

        {activeVariants.length > 0 && (
          <div className="mb-4">
            <p className="mb-1.5 text-xs font-semibold text-neutral-700">Choose an option</p>
            <div className="space-y-1.5">
              {activeVariants.map((v) => (
                <label
                  key={v.id}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="variant"
                      checked={variantId === v.id}
                      onChange={() => setVariantId(v.id)}
                    />
                    {v.name}
                  </span>
                  <span className="text-neutral-500">{formatNPR(v.priceInPaisa)}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {availableAddons.length > 0 && (
          <div className="mb-4">
            <p className="mb-1.5 text-xs font-semibold text-neutral-700">Add-ons</p>
            <div className="space-y-1.5">
              {availableAddons.map((a) => (
                <label
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={addonIds.includes(a.id)}
                      onChange={() => toggleAddon(a.id)}
                    />
                    {a.name}
                  </span>
                  <span className="text-neutral-500">
                    {a.priceInPaisa > 0 ? `+${formatNPR(a.priceInPaisa)}` : "free"}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <textarea
          className="input mb-4"
          rows={2}
          placeholder="Special instructions (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs font-semibold text-neutral-700">Quantity</p>
          <div className="flex items-center gap-3">
            <button
              className="h-8 w-8 rounded-full border border-neutral-300 text-neutral-600"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            >
              −
            </button>
            <span className="w-6 text-center text-sm font-medium">{quantity}</span>
            <button
              className="h-8 w-8 rounded-full border border-neutral-300 text-neutral-600"
              onClick={() => setQuantity((q) => Math.min(50, q + 1))}
            >
              +
            </button>
          </div>
        </div>

        <button
          onClick={handleAdd}
          disabled={activeVariants.length > 0 && !variantId}
          className="btn-primary w-full disabled:opacity-50"
        >
          Add to order · {formatNPR(lineTotal)}
        </button>
      </div>
    </div>
  );
}
