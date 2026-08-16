"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api-client";
import { formatNPR, paisaToRupees } from "@/lib/money";
import { fileToCompressedDataUrl, ClientImageError } from "@/lib/client-image";
import { MenuItemThumb } from "@/components/MenuItemThumb";

type Category = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
};

type KitchenStation = {
  id: string;
  name: string;
};

type Variant = {
  id: string;
  menuItemId: string;
  name: string;
  priceInPaisa: number;
  isActive: boolean;
};

type Addon = {
  id: string;
  menuItemId: string;
  name: string;
  priceInPaisa: number;
  isAvailable: boolean;
};

type MenuItem = {
  id: string;
  categoryId: string;
  kitchenStationId: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sku: string | null;
  basePriceInPaisa: number;
  taxRateBasisPoints: number;
  prepTimeMinutes: number | null;
  isAvailable: boolean;
  isActive: boolean;
  variants: Variant[];
  addons: Addon[];
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

export function MenuManager({ slug, canEditPrice }: { slug: string; canEditPrice: boolean }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [stations, setStations] = useState<KitchenStation[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<MenuItem | "new" | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [catRes, stationRes, itemRes] = await Promise.all([
        apiGet<{ categories: Category[] }>(`${base(slug)}/categories`),
        apiGet<{ kitchenStations: KitchenStation[] }>(`${base(slug)}/kitchen-stations`),
        apiGet<{ menuItems: MenuItem[] }>(`${base(slug)}/menu-items`),
      ]);
      setCategories(catRes.categories);
      setStations(stationRes.kitchenStations);
      setItems(itemRes.menuItems);
      setSelectedCategoryId((prev) => prev ?? catRes.categories[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the menu.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Mount-time (and slug-change-time) data fetch, not a cascading-render
    // loop — loadAll() only runs again if `slug` itself changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const activeCategories = categories.filter((c) => c.isActive);
  const itemsInSelectedCategory = useMemo(
    () =>
      items
        .filter((i) => i.categoryId === selectedCategoryId && i.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items, selectedCategoryId],
  );

  async function handleAddCategory() {
    const name = window.prompt("Category name (e.g. MOMO, DRINKS)");
    if (!name || !name.trim()) return;
    try {
      const res = await apiPost<{ category: Category }>(`${base(slug)}/categories`, { name });
      setCategories((prev) => [...prev, res.category]);
      setSelectedCategoryId(res.category.id);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not create category.");
    }
  }

  async function handleRenameCategory(category: Category) {
    const name = window.prompt("Rename category", category.name);
    if (!name || !name.trim() || name === category.name) return;
    try {
      const res = await apiPatch<{ category: Category }>(
        `${base(slug)}/categories/${category.id}`,
        { name },
      );
      setCategories((prev) => prev.map((c) => (c.id === category.id ? res.category : c)));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not rename category.");
    }
  }

  async function handleDeactivateCategory(category: Category) {
    if (
      !window.confirm(
        `Deactivate "${category.name}"? Its items will stop showing up as orderable. This can be reversed later from the database, but not yet from this screen.`,
      )
    )
      return;
    try {
      await apiDelete(`${base(slug)}/categories/${category.id}`);
      setCategories((prev) => prev.filter((c) => c.id !== category.id));
      if (selectedCategoryId === category.id) {
        setSelectedCategoryId(activeCategories.find((c) => c.id !== category.id)?.id ?? null);
      }
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not deactivate category.");
    }
  }

  async function moveCategory(category: Category, direction: -1 | 1) {
    const ordered = [...activeCategories].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = ordered.findIndex((c) => c.id === category.id);
    const swapWith = ordered[index + direction];
    if (!swapWith) return;
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    const orderedIds = ordered.map((c) => c.id);
    try {
      await apiPost(`${base(slug)}/categories/reorder`, { orderedIds });
      setCategories((prev) =>
        prev.map((c) => {
          const newIndex = orderedIds.indexOf(c.id);
          return newIndex === -1 ? c : { ...c, sortOrder: newIndex };
        }),
      );
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not reorder categories.");
    }
  }

  async function handleToggleAvailability(item: MenuItem) {
    try {
      const res = await apiPatch<{ menuItem: MenuItem }>(
        `${base(slug)}/menu-items/${item.id}`,
        { isAvailable: !item.isAvailable },
      );
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...res.menuItem } : i)));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update availability.");
    }
  }

  async function handleDeactivateItem(item: MenuItem) {
    if (!window.confirm(`Remove "${item.name}" from the menu?`)) return;
    try {
      await apiDelete(`${base(slug)}/menu-items/${item.id}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not remove item.");
    }
  }

  function upsertItemInState(item: MenuItem) {
    setItems((prev) => {
      const exists = prev.some((i) => i.id === item.id);
      return exists ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item];
    });
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading menu…</p>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* Category strip */}
      <div className="flex flex-wrap items-center gap-2">
        {activeCategories
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((category, i) => (
            <div
              key={category.id}
              className={`group flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm ${
                selectedCategoryId === category.id
                  ? "border-orange-600 bg-orange-50 text-orange-700"
                  : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              <button onClick={() => setSelectedCategoryId(category.id)} className="font-medium">
                {category.name}
              </button>
              <button
                onClick={() => moveCategory(category, -1)}
                disabled={i === 0}
                className="text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-30"
                title="Move left"
              >
                ←
              </button>
              <button
                onClick={() => moveCategory(category, 1)}
                disabled={i === activeCategories.length - 1}
                className="text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-30"
                title="Move right"
              >
                →
              </button>
              <button
                onClick={() => handleRenameCategory(category)}
                className="text-xs text-neutral-400 hover:text-neutral-700"
                title="Rename"
              >
                ✎
              </button>
              <button
                onClick={() => handleDeactivateCategory(category)}
                className="text-xs text-neutral-400 hover:text-red-600"
                title="Remove category"
              >
                ✕
              </button>
            </div>
          ))}
        <button onClick={handleAddCategory} className="btn-secondary text-sm">
          + Category
        </button>
      </div>

      {activeCategories.length === 0 && (
        <p className="text-sm text-neutral-500">
          No categories yet. Add one (e.g. &quot;Momo&quot;, &quot;Drinks&quot;) to start
          building your menu.
        </p>
      )}

      {selectedCategoryId && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">
              Items in {categories.find((c) => c.id === selectedCategoryId)?.name}
            </h2>
            <button onClick={() => setEditingItem("new")} className="btn-primary text-sm">
              + Item
            </button>
          </div>

          {itemsInSelectedCategory.length === 0 ? (
            <p className="text-sm text-neutral-500">No items in this category yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {itemsInSelectedCategory.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-3">
                      <MenuItemThumb imageUrl={item.imageUrl} name={item.name} size="md" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-neutral-900">{item.name}</p>
                        <p className="text-sm text-neutral-500">
                          {item.variants.filter((v) => v.isActive).length > 0
                            ? variantPriceRange(item.variants)
                            : formatNPR(item.basePriceInPaisa)}
                        </p>
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
                      <input
                        type="checkbox"
                        checked={item.isAvailable}
                        onChange={() => handleToggleAvailability(item)}
                      />
                      Available
                    </label>
                  </div>

                  {item.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-neutral-500">
                      {item.description}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.sku && (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">
                        SKU {item.sku}
                      </span>
                    )}
                    {item.prepTimeMinutes != null && (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">
                        {item.prepTimeMinutes} min
                      </span>
                    )}
                    {item.kitchenStationId && (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">
                        {stations.find((s) => s.id === item.kitchenStationId)?.name ?? "Station"}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <button
                      onClick={() => setEditingItem(item)}
                      className="font-medium text-orange-600 hover:text-orange-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() =>
                        setExpandedItemId((prev) => (prev === item.id ? null : item.id))
                      }
                      className="font-medium text-neutral-600 hover:text-neutral-900"
                    >
                      Variants &amp; add-ons ({item.variants.length + item.addons.length})
                    </button>
                    <button
                      onClick={() => handleDeactivateItem(item)}
                      className="font-medium text-neutral-400 hover:text-red-600"
                    >
                      Remove
                    </button>
                  </div>

                  {expandedItemId === item.id && (
                    <VariantsAndAddons
                      slug={slug}
                      item={item}
                      canEditPrice={canEditPrice}
                      onChange={upsertItemInState}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editingItem && (
        <ItemFormModal
          slug={slug}
          item={editingItem === "new" ? null : editingItem}
          defaultCategoryId={selectedCategoryId}
          categories={activeCategories}
          stations={stations}
          canEditPrice={canEditPrice}
          onClose={() => setEditingItem(null)}
          onSaved={(item) => {
            upsertItemInState(item);
            setEditingItem(null);
          }}
        />
      )}
    </div>
  );
}

function variantPriceRange(variants: Variant[]): string {
  const active = variants.filter((v) => v.isActive);
  const prices = active.map((v) => v.priceInPaisa);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatNPR(min) : `${formatNPR(min)} – ${formatNPR(max)}`;
}

function VariantsAndAddons({
  slug,
  item,
  canEditPrice,
  onChange,
}: {
  slug: string;
  item: MenuItem;
  canEditPrice: boolean;
  onChange: (item: MenuItem) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function addVariant() {
    const name = window.prompt("Variant name (e.g. Small, Medium, Large)");
    if (!name || !name.trim()) return;
    const priceStr = window.prompt(`Price for "${name}" (Rs.)`);
    const price = Number(priceStr);
    if (!priceStr || Number.isNaN(price) || price < 0) return;
    setBusy(true);
    try {
      const res = await apiPost<{ variant: Variant }>(
        `/api/restaurants/${slug}/menu-items/${item.id}/variants`,
        { name, price },
      );
      onChange({ ...item, variants: [...item.variants, res.variant] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not add variant.");
    } finally {
      setBusy(false);
    }
  }

  async function removeVariant(variant: Variant) {
    setBusy(true);
    try {
      await apiDelete(
        `/api/restaurants/${slug}/menu-items/${item.id}/variants/${variant.id}`,
      );
      onChange({
        ...item,
        variants: item.variants.map((v) => (v.id === variant.id ? { ...v, isActive: false } : v)),
      });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not remove variant.");
    } finally {
      setBusy(false);
    }
  }

  async function addAddon() {
    const name = window.prompt("Add-on name (e.g. Extra spicy, Extra cheese)");
    if (!name || !name.trim()) return;
    const priceStr = window.prompt(`Extra price for "${name}" (Rs., 0 if free)`, "0");
    const price = Number(priceStr ?? "0");
    if (Number.isNaN(price) || price < 0) return;
    setBusy(true);
    try {
      const res = await apiPost<{ addon: Addon }>(
        `/api/restaurants/${slug}/menu-items/${item.id}/addons`,
        { name, price },
      );
      onChange({ ...item, addons: [...item.addons, res.addon] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not add add-on.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAddon(addon: Addon) {
    setBusy(true);
    try {
      await apiDelete(`/api/restaurants/${slug}/menu-items/${item.id}/addons/${addon.id}`);
      onChange({
        ...item,
        addons: item.addons.map((a) => (a.id === addon.id ? { ...a, isAvailable: false } : a)),
      });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not remove add-on.");
    } finally {
      setBusy(false);
    }
  }

  const activeVariants = item.variants.filter((v) => v.isActive);
  const activeAddons = item.addons.filter((a) => a.isAvailable);

  return (
    <div className="mt-3 space-y-3 border-t border-neutral-100 pt-3">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-semibold text-neutral-700">Variants</p>
          {canEditPrice && (
            <button
              onClick={addVariant}
              disabled={busy}
              className="text-xs font-medium text-orange-600 hover:text-orange-700"
            >
              + Add
            </button>
          )}
        </div>
        {activeVariants.length === 0 ? (
          <p className="text-xs text-neutral-400">
            No variants — item uses its base price. Add e.g. Small/Medium/Large if this item
            comes in sizes.
          </p>
        ) : (
          <ul className="space-y-1">
            {activeVariants.map((v) => (
              <li key={v.id} className="flex items-center justify-between text-xs">
                <span>
                  {v.name} — {formatNPR(v.priceInPaisa)}
                </span>
                <button
                  onClick={() => removeVariant(v)}
                  disabled={busy}
                  className="text-neutral-400 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-semibold text-neutral-700">Add-ons</p>
          <button
            onClick={addAddon}
            disabled={busy}
            className="text-xs font-medium text-orange-600 hover:text-orange-700"
          >
            + Add
          </button>
        </div>
        {activeAddons.length === 0 ? (
          <p className="text-xs text-neutral-400">
            No add-ons — e.g. &quot;Extra spicy&quot; or &quot;Extra sauce&quot;.
          </p>
        ) : (
          <ul className="space-y-1">
            {activeAddons.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-xs">
                <span>
                  {a.name}
                  {a.priceInPaisa > 0 ? ` — +${formatNPR(a.priceInPaisa)}` : " — free"}
                </span>
                <button
                  onClick={() => removeAddon(a)}
                  disabled={busy}
                  className="text-neutral-400 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ItemFormModal({
  slug,
  item,
  defaultCategoryId,
  categories,
  stations,
  canEditPrice,
  onClose,
  onSaved,
}: {
  slug: string;
  item: MenuItem | null;
  defaultCategoryId: string | null;
  categories: Category[];
  stations: KitchenStation[];
  canEditPrice: boolean;
  onClose: () => void;
  onSaved: (item: MenuItem) => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? defaultCategoryId ?? "");
  const [kitchenStationId, setKitchenStationId] = useState(item?.kitchenStationId ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [imageUrl, setImageUrl] = useState(item?.imageUrl ?? "");
  const [sku, setSku] = useState(item?.sku ?? "");
  const [price, setPrice] = useState(
    item ? String(paisaToRupees(item.basePriceInPaisa)) : "",
  );
  const [taxPercent, setTaxPercent] = useState(
    item ? String(item.taxRateBasisPoints / 100) : "0",
  );
  const [prepTime, setPrepTime] = useState(item?.prepTimeMinutes?.toString() ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-choosing the same file later
    if (!file) return;
    setImageError(null);
    setImageProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      setImageUrl(dataUrl);
    } catch (err) {
      setImageError(err instanceof ClientImageError ? err.message : "Could not process that image.");
    } finally {
      setImageProcessing(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name,
        categoryId,
        kitchenStationId: kitchenStationId || null,
        description,
        imageUrl,
        sku,
        prepTimeMinutes: prepTime === "" ? undefined : Number(prepTime),
      };
      if (canEditPrice || !item) {
        payload.price = Number(price);
        payload.taxRatePercent = Number(taxPercent || 0);
      }

      if (item) {
        const res = await apiPatch<{ menuItem: Omit<MenuItem, "variants" | "addons"> }>(
          `/api/restaurants/${slug}/menu-items/${item.id}`,
          payload,
        );
        onSaved({ ...item, ...res.menuItem });
      } else {
        const res = await apiPost<{ menuItem: Omit<MenuItem, "variants" | "addons"> }>(
          `/api/restaurants/${slug}/menu-items`,
          payload,
        );
        onSaved({ ...res.menuItem, variants: [], addons: [] });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save item.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-neutral-900">
            {item ? "Edit item" : "New item"}
          </h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            required
            className="input"
            placeholder="Item name (e.g. Buff Momo)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <select
            required
            className="input"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="" disabled>
              Select category
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={kitchenStationId}
            onChange={(e) => setKitchenStationId(e.target.value)}
          >
            <option value="">No kitchen station</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <textarea
            className="input"
            placeholder="Description (optional)"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div>
            <span className="mb-1 block text-xs font-medium text-neutral-500">
              Photo (optional)
            </span>
            <div className="flex items-center gap-3">
              <MenuItemThumb imageUrl={imageUrl} name={name || "?"} size="md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChosen}
                  className="hidden"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={imageProcessing}
                    className="btn-secondary text-xs disabled:opacity-50"
                  >
                    {imageProcessing ? "Processing…" : imageUrl ? "Replace photo" : "Upload photo"}
                  </button>
                  {imageUrl && (
                    <button
                      type="button"
                      onClick={() => setImageUrl("")}
                      className="text-xs font-medium text-neutral-400 hover:text-red-600"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  className="input text-xs"
                  placeholder="…or paste an image URL"
                  value={imageUrl.startsWith("data:") ? "" : imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                />
              </div>
            </div>
            {imageError && <p className="mt-1 text-xs text-red-600">{imageError}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input
              className="input"
              placeholder="SKU (optional)"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
            />
            <input
              className="input"
              type="number"
              min={0}
              placeholder="Prep time (min)"
              value={prepTime}
              onChange={(e) => setPrepTime(e.target.value)}
            />
          </div>

          {(canEditPrice || !item) && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-neutral-500">
                  Price (Rs.)
                </span>
                <input
                  required
                  className="input"
                  type="number"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-neutral-500">Tax %</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={taxPercent}
                  onChange={(e) => setTaxPercent(e.target.value)}
                />
              </label>
            </div>
          )}
          {!canEditPrice && item && (
            <p className="text-xs text-neutral-400">
              You don&apos;t have permission to change prices. Current price:{" "}
              {formatNPR(item.basePriceInPaisa)}.
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="btn-primary flex-1">
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
