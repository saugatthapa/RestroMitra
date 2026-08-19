"use client";

import { useEffect, useMemo, useState } from "react";
import { formatNPR } from "@/lib/money";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { MenuItemThumb } from "@/components/MenuItemThumb";

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

export function PublicOrderMenu({
  token,
  restaurantName,
  tableName,
  categories,
}: {
  token: string;
  restaurantName: string;
  tableName: string;
  categories: Category[];
}) {
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
      setCallError(err instanceof ApiError ? err.message : "Couldn't reach staff. Please try again.");
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
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-6 text-center">
        <div>
          <p className="text-lg font-semibold text-neutral-900">{restaurantName}</p>
          <p className="mt-2 text-sm text-neutral-500">
            The menu isn&apos;t available for ordering right now. Please ask staff for help.
          </p>
        </div>
      </div>
    );
  }

  if (view === "confirmation" && confirmation) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 p-6 text-center">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-600">
            ✓
          </div>
          <p className="text-lg font-semibold text-neutral-900">Order placed!</p>
          <p className="mt-1 text-sm text-neutral-500">Show this screen to staff if needed.</p>
          <div className="mt-4 space-y-1 rounded-xl bg-neutral-50 p-4 text-left text-sm">
            <p>
              <span className="text-neutral-500">Order #</span>{" "}
              <span className="font-semibold">{confirmation.orderNumber}</span>
            </p>
            <p>
              <span className="text-neutral-500">Table</span>{" "}
              <span className="font-semibold">{tableName}</span>
            </p>
            <p>
              <span className="text-neutral-500">Total</span>{" "}
              <span className="font-semibold">{formatNPR(confirmation.totalInPaisa)}</span>
            </p>
          </div>
          <button
            className="btn-secondary mt-5 w-full"
            onClick={() => {
              setCart([]);
              setConfirmation(null);
              setView("menu");
            }}
          >
            Order more
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
    <div className="min-h-full bg-neutral-50 pb-24">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-neutral-900">{restaurantName}</p>
          <p className="text-xs text-neutral-500">{tableName}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
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
              {call.status === "acknowledged" ? "Staff on the way" : "Staff notified"}
            </span>
          ) : (
            <button
              onClick={callStaff}
              disabled={callRequesting}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 active:bg-neutral-50 disabled:opacity-50"
            >
              🔔 {callRequesting ? "Calling…" : "Call staff"}
            </button>
          )}
          {callError && <p className="text-[11px] text-red-600">{callError}</p>}
        </div>
      </header>

      {view === "menu" && (
        <>
          {categories.length > 1 && (
            <div className="sticky top-[52px] z-10 flex gap-2 overflow-x-auto border-b border-neutral-200 bg-white px-4 py-2">
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
          )}

          <div className="space-y-3 px-4 py-4">
            {categories
              .find((c) => c.id === selectedCategoryId)
              ?.menuItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setCustomizingItem(item)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3 text-left shadow-sm"
                >
                  <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-neutral-900">{item.name}</p>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-neutral-500">
                        {item.description}
                      </p>
                    )}
                    <p className="mt-1 text-sm font-medium text-orange-700">
                      {item.variants.length > 0
                        ? priceRange(item.variants)
                        : formatNPR(item.basePriceInPaisa)}
                    </p>
                  </div>
                  <span className="shrink-0 self-end rounded-full bg-orange-600 px-3 py-1 text-xs font-semibold text-white">
                    Add
                  </span>
                </button>
              ))}
          </div>

          <p className="px-4 pb-2 pt-1 text-center text-[11px] text-neutral-400">
            <a
              href="/"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-neutral-600 hover:underline"
            >
              Powered by RestroMitra
            </a>
          </p>
        </>
      )}

      {view === "cart" && (
        <CartView
          cart={cart}
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
          onClose={() => setCustomizingItem(null)}
          onAdd={addToCart}
        />
      )}

      {view === "menu" && cartCount > 0 && (
        <button
          onClick={() => setView("cart")}
          className="fixed inset-x-4 bottom-4 z-20 flex items-center justify-between rounded-2xl bg-orange-600 px-5 py-3.5 text-sm font-semibold text-white shadow-lg"
        >
          <span>
            View cart · {cartCount} item{cartCount === 1 ? "" : "s"}
          </span>
          <span>{formatNPR(cartTotal)}</span>
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
  onClose,
  onAdd,
}: {
  item: MenuItem;
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
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        {item.imageUrl && (
          <div className="-mx-5 -mt-5 mb-4 aspect-[16/9] w-[calc(100%+2.5rem)] overflow-hidden bg-neutral-50 sm:rounded-t-2xl">
            <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="fill" rounded="rounded-none" />
          </div>
        )}
        <div className="mb-3 flex items-start justify-between">
          <div>
            <p className="text-base font-semibold text-neutral-900">{item.name}</p>
            {item.description && (
              <p className="mt-0.5 text-xs text-neutral-500">{item.description}</p>
            )}
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            ✕
          </button>
        </div>

        {item.variants.length > 0 && (
          <div className="mb-4">
            <p className="mb-1.5 text-xs font-semibold text-neutral-700">Choose an option</p>
            <div className="space-y-1.5">
              {item.variants.map((v) => (
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

        {item.addons.length > 0 && (
          <div className="mb-4">
            <p className="mb-1.5 text-xs font-semibold text-neutral-700">Add-ons</p>
            <div className="space-y-1.5">
              {item.addons.map((a) => (
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
          disabled={item.variants.length > 0 && !variantId}
          className="btn-primary w-full disabled:opacity-50"
        >
          Add to cart · {formatNPR(lineTotal)}
        </button>
      </div>
    </div>
  );
}

function CartView({
  cart,
  onBack,
  onRemove,
  onChangeQuantity,
  onCheckout,
}: {
  cart: CartLine[];
  onBack: () => void;
  onRemove: (key: string) => void;
  onChangeQuantity: (key: string, delta: number) => void;
  onCheckout: () => void;
}) {
  const total = cart.reduce((sum, l) => sum + cartLineTotal(l), 0);

  return (
    <div className="px-4 py-4">
      <button onClick={onBack} className="mb-4 text-sm text-neutral-500">
        ← Back to menu
      </button>
      <h1 className="mb-3 text-base font-semibold text-neutral-900">Your order</h1>

      {cart.length === 0 ? (
        <p className="text-sm text-neutral-500">Your cart is empty.</p>
      ) : (
        <div className="space-y-3">
          {cart.map((line) => (
            <div key={line.key} className="rounded-2xl border border-neutral-200 bg-white p-4">
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
                  className="text-xs text-neutral-400 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    className="h-7 w-7 rounded-full border border-neutral-300 text-neutral-600"
                    onClick={() => onChangeQuantity(line.key, -1)}
                  >
                    −
                  </button>
                  <span className="w-5 text-center text-sm">{line.quantity}</span>
                  <button
                    className="h-7 w-7 rounded-full border border-neutral-300 text-neutral-600"
                    onClick={() => onChangeQuantity(line.key, 1)}
                  >
                    +
                  </button>
                </div>
                <p className="text-sm font-semibold text-neutral-900">
                  {formatNPR(cartLineTotal(line))}
                </p>
              </div>
            </div>
          ))}

          <div className="border-t border-neutral-200 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold text-neutral-900">Subtotal</span>
              <span className="whitespace-nowrap text-sm font-semibold text-neutral-900">
                {formatNPR(total)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-neutral-400">Tax calculated at checkout</p>
          </div>

          <button onClick={onCheckout} className="btn-primary w-full">
            Checkout
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
  onBack,
  onPlaced,
}: {
  token: string;
  cart: CartLine[];
  total: number;
  onBack: () => void;
  onPlaced: (order: { orderNumber: string; totalInPaisa: number }) => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      });
      onPlaced(res.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not place your order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-4">
      <button onClick={onBack} className="mb-4 text-sm text-neutral-500" disabled={submitting}>
        ← Back to cart
      </button>
      <h1 className="mb-3 text-base font-semibold text-neutral-900">Checkout</h1>

      <div className="space-y-3">
        <input
          className="input"
          placeholder="Your name (optional)"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
        />
        <input
          className="input"
          placeholder="Phone number (optional)"
          value={customerPhone}
          onChange={(e) => setCustomerPhone(e.target.value)}
        />
        <textarea
          className="input"
          rows={2}
          placeholder="Notes for the kitchen (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="rounded-xl bg-neutral-50 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold text-neutral-900">Estimated subtotal</span>
            <span className="whitespace-nowrap font-semibold text-neutral-900">
              {formatNPR(total)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-neutral-400">Tax added on submission</p>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button onClick={handleSubmit} disabled={submitting} className="btn-primary w-full">
          {submitting ? "Placing order…" : "Place order"}
        </button>
      </div>
    </div>
  );
}
