"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR, paisaToRupees } from "@/lib/money";

type Variant = { id: string; name: string; priceInPaisa: number; isActive: boolean };
type MenuItemOption = {
  id: string;
  name: string;
  basePriceInPaisa: number;
  isActive: boolean;
  isAvailable: boolean;
  variants: Variant[];
};

type ComboItem = { id: string; menuItemId: string; variantId: string | null; quantity: number };
type Combo = {
  id: string;
  name: string;
  description: string | null;
  priceInPaisa: number;
  isActive: boolean;
  items: ComboItem[];
};

// A row in the item-builder UI, before it's sent to the API — see
// itemRowsToPayload below for the shape the API actually wants.
type ItemRow = { key: string; menuItemId: string; variantId: string; quantity: string };

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function newRow(menuItemId = ""): ItemRow {
  return { key: crypto.randomUUID(), menuItemId, variantId: "", quantity: "1" };
}

function itemRowsToPayload(rows: ItemRow[]) {
  return rows
    .filter((r) => r.menuItemId)
    .map((r) => ({
      menuItemId: r.menuItemId,
      variantId: r.variantId || undefined,
      quantity: Math.max(1, Math.floor(Number(r.quantity) || 1)),
    }));
}

export function CombosBoard({ slug }: { slug: string }) {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const orderableItems = useMemo(
    () => menuItems.filter((i) => i.isActive && i.isAvailable),
    [menuItems],
  );
  const menuItemById = useMemo(() => new Map(menuItems.map((i) => [i.id, i])), [menuItems]);

  async function load() {
    setLoading(true);
    try {
      const [combosRes, itemsRes] = await Promise.all([
        apiGet<{ combos: Combo[] }>(`${base(slug)}/combos`),
        apiGet<{ menuItems: MenuItemOption[] }>(`${base(slug)}/menu-items`),
      ]);
      setCombos(combosRes.combos);
      setMenuItems(itemsRes.menuItems);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load combos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {combos.length} combo{combos.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={() => setShowAdd((v) => !v)}
          disabled={orderableItems.length === 0}
          className="btn-primary disabled:opacity-50"
        >
          {showAdd ? "Cancel" : "+ New combo"}
        </button>
      </div>

      {!loading && orderableItems.length === 0 && (
        <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-300">
          Add an active, available menu item first — a combo needs at least one item to bundle.
        </p>
      )}

      {showAdd && (
        <ComboForm
          slug={slug}
          menuItems={orderableItems}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading combos…</p>
      ) : combos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-hairline-strong px-4 py-8 text-center text-sm text-ink-faint">
          No combos yet. Bundle a few menu items at a fixed price for staff to add at the POS.
        </p>
      ) : (
        <div className="space-y-2">
          {combos.map((c) => (
            <ComboRow
              key={c.id}
              slug={slug}
              combo={c}
              menuItems={orderableItems}
              menuItemById={menuItemById}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared item-builder rows (used by both create and edit forms)
// ---------------------------------------------------------------------------

function ItemRowsBuilder({
  rows,
  setRows,
  menuItems,
}: {
  rows: ItemRow[];
  setRows: (rows: ItemRow[]) => void;
  menuItems: MenuItemOption[];
}) {
  function updateRow(key: string, patch: Partial<ItemRow>) {
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeRow(key: string) {
    setRows(rows.filter((r) => r.key !== key));
  }

  return (
    <div className="space-y-2">
      <span className="mb-1 block text-sm text-ink-secondary">Items in this combo</span>
      {rows.map((row) => {
        const item = menuItems.find((i) => i.id === row.menuItemId);
        const activeVariants = item?.variants.filter((v) => v.isActive) ?? [];
        return (
          <div key={row.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline p-2">
            <select
              value={row.menuItemId}
              onChange={(e) => updateRow(row.key, { menuItemId: e.target.value, variantId: "" })}
              className="input min-w-[10rem] flex-1"
            >
              <option value="">Choose an item…</option>
              {menuItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            {activeVariants.length > 0 && (
              <select
                value={row.variantId}
                onChange={(e) => updateRow(row.key, { variantId: e.target.value })}
                className="input min-w-[8rem] flex-1"
              >
                <option value="">No specific variant (base price)</option>
                {activeVariants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              value={row.quantity}
              onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
              className="input w-20"
              title="Quantity per bundle"
            />
            <button
              type="button"
              onClick={() => removeRow(row.key)}
              className="shrink-0 text-ink-faint hover:text-red-400"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setRows([...rows, newRow()])}
        className="btn-secondary text-xs"
      >
        + Add item
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function ComboForm({
  slug,
  menuItems,
  onSaved,
  onCancel,
}: {
  slug: string;
  menuItems: MenuItemOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [rows, setRows] = useState<ItemRow[]>([newRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const items = itemRowsToPayload(rows);
    if (items.length === 0) {
      setError("Add at least one item to the combo.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/combos`, {
        name,
        description: description || undefined,
        price: Number(price),
        items,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create combo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-secondary">Combo name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            placeholder="Momo + Coke Combo"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Bundle price (Rs.)</span>
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm sm:col-span-3">
          <span className="mb-1 block text-ink-secondary">Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </label>
      </div>
      <ItemRowsBuilder rows={rows} setRows={setRows} menuItems={menuItems} />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? "Creating…" : "Create combo"}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Row + inline edit
// ---------------------------------------------------------------------------

function ComboRow({
  slug,
  combo,
  menuItems,
  menuItemById,
  onChanged,
}: {
  slug: string;
  combo: Combo;
  menuItems: MenuItemOption[];
  menuItemById: Map<string, MenuItemOption>;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleActive() {
    setTogglingActive(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/combos/${combo.id}`, { isActive: !combo.isActive });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update combo.");
    } finally {
      setTogglingActive(false);
    }
  }

  function describeItem(ci: ComboItem): string {
    const item = menuItemById.get(ci.menuItemId);
    if (!item) return "Item no longer on the menu";
    const variant = ci.variantId ? item.variants.find((v) => v.id === ci.variantId) : null;
    return `${ci.quantity}× ${item.name}${variant ? ` (${variant.name})` : ""}`;
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-ink">{combo.name}</span>
            <span className="rounded-full bg-surface-1 px-2 py-0.5 text-xs text-ink-secondary">
              {formatNPR(combo.priceInPaisa)}
            </span>
            {!combo.isActive && (
              <span className="rounded-full bg-surface-3 px-2 py-0.5 text-xs text-ink-secondary">Inactive</span>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {combo.items.map(describeItem).join(", ")}
            {combo.description && <> · {combo.description}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setEditing((v) => !v)} className="btn-secondary text-xs">
            {editing ? "Close" : "Edit"}
          </button>
          <button onClick={toggleActive} disabled={togglingActive} className="btn-secondary text-xs">
            {combo.isActive ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
      {editing && (
        <div className="mt-4 border-t border-hairline/60 pt-4">
          <EditComboForm
            slug={slug}
            combo={combo}
            menuItems={menuItems}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}

function EditComboForm({
  slug,
  combo,
  menuItems,
  onSaved,
}: {
  slug: string;
  combo: Combo;
  menuItems: MenuItemOption[];
  onSaved: () => void;
}) {
  const [name, setName] = useState(combo.name);
  const [description, setDescription] = useState(combo.description ?? "");
  const [price, setPrice] = useState(String(paisaToRupees(combo.priceInPaisa)));
  const [rows, setRows] = useState<ItemRow[]>(() =>
    combo.items.length > 0
      ? combo.items.map((ci) => ({
          key: crypto.randomUUID(),
          menuItemId: ci.menuItemId,
          variantId: ci.variantId ?? "",
          quantity: String(ci.quantity),
        }))
      : [newRow()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `items` is always sent as the COMPLETE new set (whole-state-replace —
  // see updateComboSchema's own comment), never a patch, so every row
  // currently in the builder is submitted every time, not just changed ones.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const items = itemRowsToPayload(rows);
    if (items.length === 0) {
      setError("A combo needs at least one item.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/combos/${combo.id}`, {
        name,
        description: description || null,
        price: Number(price),
        items,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-secondary">Combo name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Bundle price (Rs.)</span>
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm sm:col-span-3">
          <span className="mb-1 block text-ink-secondary">Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </label>
      </div>
      <ItemRowsBuilder rows={rows} setRows={setRows} menuItems={menuItems} />
      <button type="submit" disabled={saving} className="btn-primary">
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
