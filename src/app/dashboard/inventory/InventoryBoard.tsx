"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPut, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { INVENTORY_UNITS, INVENTORY_UNIT_LABELS, type InventoryUnit } from "@/lib/inventory-units";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { useBranchSelection } from "@/lib/branch-context";
import { WASTE_REASONS, WASTE_REASON_LABELS, type WasteReasonValue } from "@/lib/waste-reasons";

type Supplier = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
};

type InventoryItem = {
  id: string;
  name: string;
  unit: InventoryUnit;
  currentStockMilliunits: number;
  reorderLevelMilliunits: number | null;
  costPerUnitInPaisa: number;
  preferredSupplierId: string | null;
  isActive: boolean;
  isLowStock: boolean;
};

type Purchase = {
  id: string;
  invoiceNumber: string | null;
  totalInPaisa: number;
  notes: string | null;
  createdAt: string;
  supplier: Supplier | null;
  items: { id: string; quantityMilliunits: number; unitCostInPaisa: number; lineTotalInPaisa: number; inventoryItem: InventoryItem }[];
};

type MenuItemSummary = { id: string; name: string };
type RecipeLine = {
  id: string;
  inventoryItemId: string;
  inventoryItemName: string;
  unit: InventoryUnit;
  quantityPerServingMilliunits: number;
  lineCostInPaisa?: number;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

const TABS = ["Items", "Suppliers", "Purchases", "Recipes"] as const;
type Tab = (typeof TABS)[number];

export function InventoryBoard({ slug, canViewProfit }: { slug: string; canViewProfit: boolean }) {
  const [tab, setTab] = useState<Tab>("Items");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-neutral-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-orange-600 text-orange-700"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Items" && <ItemsTab slug={slug} canViewProfit={canViewProfit} />}
      {tab === "Suppliers" && <SuppliersTab slug={slug} />}
      {tab === "Purchases" && <PurchasesTab slug={slug} canViewProfit={canViewProfit} />}
      {tab === "Recipes" && <RecipesTab slug={slug} canViewProfit={canViewProfit} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items tab
// ---------------------------------------------------------------------------

function ItemsTab({ slug, canViewProfit }: { slug: string; canViewProfit: boolean }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);

  async function load() {
    try {
      const [itemsRes, suppliersRes] = await Promise.all([
        apiGet<{ inventoryItems: InventoryItem[] }>(`${base(slug)}/inventory-items`),
        apiGet<{ suppliers: Supplier[] }>(`${base(slug)}/suppliers`),
      ]);
      setItems(itemsRes.inventoryItems);
      setSuppliers(suppliersRes.suppliers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load inventory items.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading) return <p className="text-sm text-neutral-500">Loading items…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex justify-end">
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
          {showCreate ? "Cancel" : "+ New item"}
        </button>
      </div>

      {showCreate && (
        <CreateItemForm
          slug={slug}
          suppliers={suppliers}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Stock</th>
              <th className="px-3 py-2">Reorder level</th>
              {canViewProfit && <th className="px-3 py-2">Cost / unit</th>}
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-400">
                  No inventory items yet.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 font-medium text-neutral-900">
                  {item.name}
                  {item.isLowStock && (
                    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                      Low stock
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{formatQuantity(item.currentStockMilliunits, item.unit)}</td>
                <td className="px-3 py-2 text-neutral-500">
                  {item.reorderLevelMilliunits === null
                    ? "—"
                    : formatQuantity(item.reorderLevelMilliunits, item.unit)}
                </td>
                {canViewProfit && (
                  <td className="px-3 py-2">{formatNPR(item.costPerUnitInPaisa)}</td>
                )}
                <td className="px-3 py-2 text-neutral-500">
                  {suppliers.find((s) => s.id === item.preferredSupplierId)?.name ?? "—"}
                </td>
                <td className="px-3 py-2">
                  {item.isActive ? (
                    <span className="text-green-700">Active</span>
                  ) : (
                    <span className="text-neutral-400">Inactive</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setAdjustingId(item.id)}
                    className="text-xs font-medium text-orange-700 hover:underline"
                  >
                    Adjust stock
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adjustingId && (
        <AdjustStockModal
          slug={slug}
          item={items.find((i) => i.id === adjustingId)!}
          onClose={() => setAdjustingId(null)}
          onSaved={() => {
            setAdjustingId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateItemForm({
  slug,
  suppliers,
  onCreated,
}: {
  slug: string;
  suppliers: Supplier[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<InventoryUnit>("kg");
  const [reorderLevel, setReorderLevel] = useState("");
  const [preferredSupplierId, setPreferredSupplierId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/inventory-items`, {
        name,
        unit,
        reorderLevel: reorderLevel ? Number(reorderLevel) : null,
        preferredSupplierId: preferredSupplierId || null,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create item.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            placeholder="e.g. Chicken (raw)"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Unit</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value as InventoryUnit)} className="input">
            {INVENTORY_UNITS.map((u) => (
              <option key={u} value={u}>
                {INVENTORY_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Reorder level (optional)</span>
          <input
            type="number"
            min="0"
            step="0.001"
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
            className="input"
            placeholder={`e.g. 5 (${unit})`}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Preferred supplier (optional)</span>
          <select
            value={preferredSupplierId}
            onChange={(e) => setPreferredSupplierId(e.target.value)}
            className="input"
          >
            <option value="">None</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        New items start at zero stock — record what&apos;s on hand with &quot;Adjust stock&quot;
        right after creating it.
      </p>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Creating…" : "Create item"}
      </button>
    </form>
  );
}

function AdjustStockModal({
  slug,
  item,
  onClose,
  onSaved,
}: {
  slug: string;
  item: InventoryItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { branches, branchId, setBranchId } = useBranchSelection();
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [isWaste, setIsWaste] = useState(false);
  const [wasteReason, setWasteReason] = useState<WasteReasonValue | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectDirection(next: "add" | "remove") {
    setDirection(next);
    // Waste only makes sense for a removal — switching to "Add" drops it
    // rather than leaving a stale, now-invalid selection sitting hidden.
    if (next === "add") {
      setIsWaste(false);
      setWasteReason("");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branchId) {
      setError("No branch available for this adjustment.");
      return;
    }
    if (isWaste && !wasteReason) {
      setError("Select a waste reason.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/inventory-items/${item.id}/adjustments`, {
        branchId,
        quantity: Number(quantity),
        direction,
        reason,
        wasteReason: isWaste ? wasteReason : null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the adjustment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Adjust stock — {item.name}</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Current: {formatQuantity(item.currentStockMilliunits, item.unit)}
        </p>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <form onSubmit={submit} className="space-y-3">
          {branches.length > 1 && (
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-600">Branch</span>
              <select
                required
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="input"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => selectDirection("add")}
              className={`flex-1 rounded-lg border px-3 py-1.5 text-sm ${
                direction === "add"
                  ? "border-green-600 bg-green-50 font-medium text-green-700"
                  : "border-neutral-200 text-neutral-600"
              }`}
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => selectDirection("remove")}
              className={`flex-1 rounded-lg border px-3 py-1.5 text-sm ${
                direction === "remove"
                  ? "border-red-600 bg-red-50 font-medium text-red-700"
                  : "border-neutral-200 text-neutral-600"
              }`}
            >
              Remove
            </button>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Quantity ({item.unit})</span>
            <input
              required
              type="number"
              min="0.001"
              step="0.001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="input"
            />
          </label>
          {direction === "remove" && (
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={isWaste}
                onChange={(e) => {
                  setIsWaste(e.target.checked);
                  if (!e.target.checked) setWasteReason("");
                }}
              />
              This is waste (spoilage, breakage, etc.)
            </label>
          )}
          {isWaste && (
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-600">Waste reason</span>
              <select
                required
                value={wasteReason}
                onChange={(e) => setWasteReason(e.target.value as WasteReasonValue)}
                className="input"
              >
                <option value="" disabled>
                  Select a reason
                </option>
                {WASTE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {WASTE_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">{isWaste ? "Details" : "Reason"}</span>
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="input"
              placeholder={isWaste ? "e.g. Left out overnight" : "e.g. Stock count correction"}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button disabled={saving} className="btn-primary">
              {saving ? "Saving…" : "Save adjustment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suppliers tab
// ---------------------------------------------------------------------------

function SuppliersTab({ slug }: { slug: string }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const res = await apiGet<{ suppliers: Supplier[] }>(`${base(slug)}/suppliers`);
      setSuppliers(res.suppliers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load suppliers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function toggleActive(supplier: Supplier) {
    try {
      await apiPatch(`${base(slug)}/suppliers/${supplier.id}`, { isActive: !supplier.isActive });
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update the supplier.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading suppliers…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex justify-end">
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
          {showCreate ? "Cancel" : "+ New supplier"}
        </button>
      </div>

      {showCreate && (
        <CreateSupplierForm
          slug={slug}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                  No suppliers yet.
                </td>
              </tr>
            )}
            {suppliers.map((s) => (
              <tr key={s.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 font-medium text-neutral-900">{s.name}</td>
                <td className="px-3 py-2 text-neutral-500">{s.phone || "—"}</td>
                <td className="px-3 py-2 text-neutral-500">{s.address || "—"}</td>
                <td className="px-3 py-2">
                  {s.isActive ? (
                    <span className="text-green-700">Active</span>
                  ) : (
                    <span className="text-neutral-400">Inactive</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => toggleActive(s)}
                    className="text-xs font-medium text-orange-700 hover:underline"
                  >
                    {s.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreateSupplierForm({ slug, onCreated }: { slug: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/suppliers`, { name, phone, address });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create supplier.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Phone (optional)</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Address (optional)</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Creating…" : "Create supplier"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Purchases tab
// ---------------------------------------------------------------------------

type PurchaseLineDraft = { inventoryItemId: string; quantity: string; unitCost: string };

function PurchasesTab({ slug, canViewProfit }: { slug: string; canViewProfit: boolean }) {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const [purchasesRes, itemsRes, suppliersRes] = await Promise.all([
        apiGet<{ purchases: Purchase[] }>(`${base(slug)}/purchases`),
        apiGet<{ inventoryItems: InventoryItem[] }>(`${base(slug)}/inventory-items`),
        apiGet<{ suppliers: Supplier[] }>(`${base(slug)}/suppliers`),
      ]);
      setPurchases(purchasesRes.purchases);
      setItems(itemsRes.inventoryItems);
      setSuppliers(suppliersRes.suppliers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load purchases.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading) return <p className="text-sm text-neutral-500">Loading purchases…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex justify-end">
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary" disabled={items.length === 0}>
          {showCreate ? "Cancel" : "+ Record purchase"}
        </button>
      </div>
      {items.length === 0 && (
        <p className="text-xs text-neutral-400">Add an inventory item first before recording a purchase.</p>
      )}

      {showCreate && (
        <CreatePurchaseForm
          slug={slug}
          items={items}
          suppliers={suppliers}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      <div className="space-y-2">
        {purchases.length === 0 && <p className="text-sm text-neutral-400">No purchases recorded yet.</p>}
        {purchases.map((p) => (
          <div key={p.id} className="rounded-2xl border border-neutral-200 bg-white p-4 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <p className="font-semibold text-neutral-900">
                {p.supplier?.name ?? "No supplier"}
                {p.invoiceNumber ? ` · Invoice ${p.invoiceNumber}` : ""}
              </p>
              <p className="text-neutral-500">{formatDate(p.createdAt, dateSystem, { withTime: true })}</p>
            </div>
            <ul className="text-neutral-600">
              {p.items.map((line) => (
                <li key={line.id}>
                  {formatQuantity(line.quantityMilliunits, line.inventoryItem.unit)} {line.inventoryItem.name}
                  {canViewProfit ? ` — ${formatNPR(line.lineTotalInPaisa)}` : ""}
                </li>
              ))}
            </ul>
            {canViewProfit && (
              <p className="mt-1 font-medium text-neutral-900">Total: {formatNPR(p.totalInPaisa)}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CreatePurchaseForm({
  slug,
  items,
  suppliers,
  onCreated,
}: {
  slug: string;
  items: InventoryItem[];
  suppliers: Supplier[];
  onCreated: () => void;
}) {
  const { branches, branchId, setBranchId } = useBranchSelection();
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lines, setLines] = useState<PurchaseLineDraft[]>([
    { inventoryItemId: items[0]?.id ?? "", quantity: "", unitCost: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateLine(index: number, patch: Partial<PurchaseLineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { inventoryItemId: items[0]?.id ?? "", quantity: "", unitCost: "" }]);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branchId) {
      setError("No branch available to receive this purchase.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/purchases`, {
        branchId,
        supplierId: supplierId || null,
        invoiceNumber,
        items: lines.map((l) => ({
          inventoryItemId: l.inventoryItemId,
          quantity: Number(l.quantity),
          unitCost: Number(l.unitCost),
        })),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the purchase.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Receiving branch</span>
            <select
              required
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="input"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Supplier (optional)</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="input">
            <option value="">None</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Invoice number (optional)</span>
          <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="input" />
        </label>
      </div>

      <div className="mt-3 space-y-2">
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-[1fr_100px_120px_auto] items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-neutral-600">Item</span>
              <select
                value={line.inventoryItemId}
                onChange={(e) => updateLine(i, { inventoryItemId: e.target.value })}
                className="input"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.unit})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-neutral-600">Qty</span>
              <input
                required
                type="number"
                min="0.001"
                step="0.001"
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                className="input"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-neutral-600">Cost / unit (Rs.)</span>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={line.unitCost}
                onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                className="input"
              />
            </label>
            <button
              type="button"
              onClick={() => removeLine(i)}
              disabled={lines.length === 1}
              className="btn-secondary"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={addLine} className="mt-2 text-xs font-medium text-orange-700 hover:underline">
        + Add another line
      </button>

      <div>
        <button disabled={saving} className="btn-primary mt-3">
          {saving ? "Saving…" : "Record purchase"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Recipes tab
// ---------------------------------------------------------------------------

function RecipesTab({ slug, canViewProfit }: { slug: string; canViewProfit: boolean }) {
  const [menuItems, setMenuItems] = useState<MenuItemSummary[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [selectedMenuItemId, setSelectedMenuItemId] = useState("");
  const [lines, setLines] = useState<RecipeLine[]>([]);
  const [costPerServing, setCostPerServing] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadOptions() {
    try {
      const [menuRes, itemsRes] = await Promise.all([
        apiGet<{ menuItems: MenuItemSummary[] }>(`${base(slug)}/menu-items`),
        apiGet<{ inventoryItems: InventoryItem[] }>(`${base(slug)}/inventory-items`),
      ]);
      setMenuItems(menuRes.menuItems);
      setInventoryItems(itemsRes.inventoryItems);
      if (menuRes.menuItems.length > 0) setSelectedMenuItemId(menuRes.menuItems[0].id);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load menu items.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function loadRecipe(menuItemId: string) {
    if (!menuItemId) return;
    setLoadingRecipe(true);
    try {
      const res = await apiGet<{ items: RecipeLine[]; costPerServingInPaisa?: number }>(
        `${base(slug)}/menu-items/${menuItemId}/recipe`,
      );
      setLines(res.items);
      setCostPerServing(res.costPerServingInPaisa ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the recipe.");
    } finally {
      setLoadingRecipe(false);
    }
  }

  useEffect(() => {
    if (selectedMenuItemId) {
      loadRecipe(selectedMenuItemId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMenuItemId]);

  function addLine() {
    if (inventoryItems.length === 0) return;
    const first = inventoryItems[0];
    setLines((prev) => [
      ...prev,
      {
        id: `draft-${prev.length}-${first.id}`,
        inventoryItemId: first.id,
        inventoryItemName: first.name,
        unit: first.unit,
        quantityPerServingMilliunits: 0,
      },
    ]);
  }

  function updateLine(index: number, patch: Partial<RecipeLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPut(`${base(slug)}/menu-items/${selectedMenuItemId}/recipe`, {
        items: lines.map((l) => ({
          inventoryItemId: l.inventoryItemId,
          quantityPerServing: l.quantityPerServingMilliunits / 1000,
        })),
      });
      await loadRecipe(selectedMenuItemId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the recipe.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (menuItems.length === 0) {
    return <p className="text-sm text-neutral-400">Add menu items first, then define their recipes here.</p>;
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <label className="block text-sm sm:max-w-xs">
        <span className="mb-1 block text-neutral-600">Menu item</span>
        <select
          value={selectedMenuItemId}
          onChange={(e) => setSelectedMenuItemId(e.target.value)}
          className="input"
        >
          {menuItems.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {loadingRecipe ? (
        <p className="text-sm text-neutral-500">Loading recipe…</p>
      ) : (
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          {lines.length === 0 && (
            <p className="mb-3 text-sm text-neutral-400">No ingredients defined for this item yet.</p>
          )}
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={line.id} className="grid grid-cols-[1fr_140px_auto] items-end gap-2">
                <label className="text-sm">
                  <span className="mb-1 block text-neutral-600">Ingredient</span>
                  <select
                    value={line.inventoryItemId}
                    onChange={(e) => {
                      const chosen = inventoryItems.find((it) => it.id === e.target.value);
                      updateLine(i, {
                        inventoryItemId: e.target.value,
                        unit: chosen?.unit ?? line.unit,
                      });
                    }}
                    className="input"
                  >
                    {inventoryItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-neutral-600">Qty / serving ({line.unit})</span>
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={line.quantityPerServingMilliunits / 1000 || ""}
                    onChange={(e) =>
                      updateLine(i, {
                        quantityPerServingMilliunits: Math.round(Number(e.target.value) * 1000),
                      })
                    }
                    className="input"
                  />
                </label>
                <button type="button" onClick={() => removeLine(i)} className="btn-secondary">
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addLine} className="mt-2 text-xs font-medium text-orange-700 hover:underline">
            + Add ingredient
          </button>

          {canViewProfit && costPerServing !== null && (
            <p className="mt-3 text-sm text-neutral-600">
              Estimated ingredient cost per serving: <span className="font-medium">{formatNPR(costPerServing)}</span>
            </p>
          )}

          <div>
            <button onClick={save} disabled={saving} className="btn-primary mt-3">
              {saving ? "Saving…" : "Save recipe"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
