"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPut, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { formatQuantity, milliunitsToUnits } from "@/lib/quantity";
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

type PurchaseLedgerEntry = {
  id: string;
  amountInPaisa: number;
  dueStatus: "none" | "outstanding" | "settled";
  settledAmountInPaisa: number;
  isVoided: boolean;
};

type Purchase = {
  id: string;
  invoiceNumber: string | null;
  totalInPaisa: number;
  notes: string | null;
  createdAt: string;
  isCredit: boolean;
  dueDate: string | null;
  isVoided: boolean;
  supplier: Supplier | null;
  items: { id: string; quantityMilliunits: number; unitCostInPaisa: number; lineTotalInPaisa: number; inventoryItem: InventoryItem }[];
  ledgerEntry: PurchaseLedgerEntry | null;
};

type SupplierDueRow = {
  purchaseId: string;
  ledgerEntryId: string;
  supplierId: string | null;
  supplierName: string | null;
  branchId: string;
  invoiceNumber: string | null;
  totalInPaisa: number;
  settledAmountInPaisa: number;
  outstandingInPaisa: number;
  dueDate: string | null;
  createdAt: string;
  isOverdue: boolean;
};

type SupplierDueReport = {
  totalDueInPaisa: number;
  overdueInPaisa: number;
  dueTodayInPaisa: number;
  dueThisWeekInPaisa: number;
  supplierWise: {
    supplierId: string | null;
    supplierName: string;
    outstandingInPaisa: number;
    overdueInPaisa: number;
    purchaseCount: number;
  }[];
  rows: SupplierDueRow[];
};

type StockCountStatus = "open" | "pending_approval" | "applied" | "rejected";

type StockCountSummary = {
  id: string;
  branchId: string;
  status: StockCountStatus;
  notes: string | null;
  hasLargeVariance: boolean;
  countedByUserId: string | null;
  submittedAt: string | null;
  appliedAt: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  rejectedByUserId: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
};

type StockCountItemRow = {
  id: string;
  inventoryItemId: string;
  systemQuantityMilliunits: number;
  physicalQuantityMilliunits: number | null;
  unitCostInPaisaSnapshot: number;
  note: string | null;
  varianceMilliunits: number | null;
  varianceValueInPaisa: number | null;
  isLarge: boolean;
};

type StockCountDetail = { stockCount: StockCountSummary; items: StockCountItemRow[] };

type StockTransferStatus = "requested" | "approved" | "dispatched" | "received" | "cancelled";

type StockTransferSummary = {
  id: string;
  fromBranchId: string;
  toBranchId: string;
  status: StockTransferStatus;
  notes: string | null;
  requestedByUserId: string | null;
  approvedAt: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
};

type StockTransferItemRow = {
  id: string;
  inventoryItemId: string;
  quantityMilliunits: number;
  receivedQuantityMilliunits: number | null;
  note: string | null;
};

type StockTransferDetail = { transfer: StockTransferSummary; items: StockTransferItemRow[] };

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

const TABS = ["Items", "Suppliers", "Purchases", "Supplier dues", "Stock counts", "Stock transfers", "Recipes"] as const;
type Tab = (typeof TABS)[number];

export function InventoryBoard({
  slug,
  canViewProfit,
  canManageAccountBooks,
  canApproveStockCount,
}: {
  slug: string;
  canViewProfit: boolean;
  canManageAccountBooks: boolean;
  canApproveStockCount: boolean;
}) {
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
      {tab === "Purchases" && (
        <PurchasesTab slug={slug} canViewProfit={canViewProfit} canManageAccountBooks={canManageAccountBooks} />
      )}
      {tab === "Supplier dues" && <SupplierDuesTab slug={slug} canManageAccountBooks={canManageAccountBooks} />}
      {tab === "Stock counts" && <StockCountsTab slug={slug} canApproveStockCount={canApproveStockCount} />}
      {tab === "Stock transfers" && <StockTransfersTab slug={slug} />}
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
  const [wastingId, setWastingId] = useState<string | null>(null);

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
                  <button
                    onClick={() => setWastingId(item.id)}
                    className="ml-3 text-xs font-medium text-red-700 hover:underline"
                  >
                    Record waste
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

      {wastingId && (
        <RecordWasteModal
          slug={slug}
          item={items.find((i) => i.id === wastingId)!}
          canViewProfit={canViewProfit}
          onClose={() => setWastingId(null)}
          onSaved={() => {
            setWastingId(null);
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branchId) {
      setError("No branch available for this adjustment.");
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
              onClick={() => setDirection("add")}
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
              onClick={() => setDirection("remove")}
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
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Reason</span>
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="input"
              placeholder="e.g. Stock count correction"
            />
          </label>
          <p className="text-xs text-neutral-400">
            Spoiled, expired, or otherwise wasted stock has its own &quot;Record waste&quot; action
            instead — it tracks a reason and cost, and shows up in the Wastage report.
          </p>
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

/**
 * Phase A.5 — a dedicated wastage-recording action, separate from the
 * generic Adjust Stock modal above (the master prompt's own "dedicated
 * workflow" requirement). Reuses the SAME backend endpoint
 * (adjustments/route.ts already branches into a structured "waste" stock
 * movement whenever a wasteReason is supplied, with its own
 * "inventory.stock.wasted" audit action) rather than standing up a
 * duplicate API surface — see that route's own doc comment. Always
 * direction="remove"; waste never adds stock.
 */
function RecordWasteModal({
  slug,
  item,
  canViewProfit,
  onClose,
  onSaved,
}: {
  slug: string;
  item: InventoryItem;
  canViewProfit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { branches, branchId, setBranchId } = useBranchSelection();
  const [quantity, setQuantity] = useState("");
  const [wasteReason, setWasteReason] = useState<WasteReasonValue | "">("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quantityNum = Number(quantity) || 0;
  const estimatedCostInPaisa = Math.round(quantityNum * item.costPerUnitInPaisa);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branchId) {
      setError("No branch available for this record.");
      return;
    }
    if (!wasteReason) {
      setError("Select a reason.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/inventory-items/${item.id}/adjustments`, {
        branchId,
        quantity: quantityNum,
        direction: "remove",
        wasteReason,
        reason: notes || WASTE_REASON_LABELS[wasteReason],
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the waste.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Record waste — {item.name}</h2>
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
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Quantity wasted ({item.unit})</span>
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
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Reason</span>
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
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Notes (optional)</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="input"
              placeholder="e.g. Left out overnight"
            />
          </label>
          {canViewProfit && quantityNum > 0 && (
            <p className="text-xs text-neutral-500">
              Estimated cost of this waste: <span className="font-medium text-neutral-900">{formatNPR(estimatedCostInPaisa)}</span>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button
              disabled={saving}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Record waste"}
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

function PurchasesTab({
  slug,
  canViewProfit,
  canManageAccountBooks,
}: {
  slug: string;
  canViewProfit: boolean;
  canManageAccountBooks: boolean;
}) {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
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
        {purchases.map((p) => {
          const outstandingInPaisa = p.ledgerEntry
            ? p.ledgerEntry.amountInPaisa - p.ledgerEntry.settledAmountInPaisa
            : 0;
          const isOutstanding = !p.isVoided && p.ledgerEntry?.dueStatus === "outstanding";
          return (
            <div
              key={p.id}
              className={`rounded-2xl border bg-white p-4 text-sm ${
                p.isVoided ? "border-neutral-200 opacity-60" : "border-neutral-200"
              }`}
            >
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-neutral-900">
                  {p.supplier?.name ?? "No supplier"}
                  {p.invoiceNumber ? ` · Invoice ${p.invoiceNumber}` : ""}
                </p>
                <div className="flex items-center gap-2">
                  {p.isVoided && (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
                      Voided
                    </span>
                  )}
                  {!p.isVoided && p.isCredit && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        isOutstanding ? "bg-amber-50 text-amber-700" : "bg-green-50 text-green-700"
                      }`}
                    >
                      {isOutstanding ? "Outstanding" : "Paid"}
                    </span>
                  )}
                  <p className="text-neutral-500">{formatDate(p.createdAt, dateSystem, { withTime: true })}</p>
                </div>
              </div>
              <ul className="text-neutral-600">
                {p.items.map((line) => (
                  <li key={line.id}>
                    {formatQuantity(line.quantityMilliunits, line.inventoryItem.unit)} {line.inventoryItem.name}
                    {canViewProfit ? ` — ${formatNPR(line.lineTotalInPaisa)}` : ""}
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                {canViewProfit && (
                  <p className="font-medium text-neutral-900">
                    Total: {formatNPR(p.totalInPaisa)}
                    {isOutstanding && canViewProfit && (
                      <span className="ml-2 font-normal text-amber-700">
                        ({formatNPR(outstandingInPaisa)} due{p.dueDate ? ` by ${p.dueDate}` : ""})
                      </span>
                    )}
                  </p>
                )}
                <div className="flex gap-3">
                  {isOutstanding && canManageAccountBooks && (
                    <button
                      onClick={() => setPayingId(p.id)}
                      className="text-xs font-medium text-orange-700 hover:underline"
                    >
                      Record payment
                    </button>
                  )}
                  {!p.isVoided && (
                    <button
                      onClick={() => setVoidingId(p.id)}
                      className="text-xs font-medium text-red-700 hover:underline"
                    >
                      Void
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {payingId && (
        <RecordPaymentModal
          slug={slug}
          purchase={purchases.find((p) => p.id === payingId)!}
          onClose={() => setPayingId(null)}
          onSaved={() => {
            setPayingId(null);
            load();
          }}
        />
      )}

      {voidingId && (
        <VoidPurchaseModal
          slug={slug}
          purchase={purchases.find((p) => p.id === voidingId)!}
          onClose={() => setVoidingId(null)}
          onSaved={() => {
            setVoidingId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RecordPaymentModal({
  slug,
  purchase,
  onClose,
  onSaved,
}: {
  slug: string;
  purchase: Purchase;
  onClose: () => void;
  onSaved: () => void;
}) {
  const remainingInPaisa = purchase.ledgerEntry
    ? purchase.ledgerEntry.amountInPaisa - purchase.ledgerEntry.settledAmountInPaisa
    : 0;
  const [amount, setAmount] = useState(String(remainingInPaisa / 100));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!purchase.ledgerEntry) return;
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/ledger/${purchase.ledgerEntry.id}/settle`, {
        amount: Number(amount),
        note,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the payment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">
          Record payment — {purchase.supplier?.name ?? "Supplier"}
        </h2>
        <p className="mb-3 text-xs text-neutral-500">Remaining due: {formatNPR(remainingInPaisa)}</p>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Amount paid (Rs.)</span>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              max={remainingInPaisa / 100}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button disabled={saving} className="btn-primary">
              {saving ? "Saving…" : "Record payment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function VoidPurchaseModal({
  slug,
  purchase,
  onClose,
  onSaved,
}: {
  slug: string;
  purchase: Purchase;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/purchases/${purchase.id}/void`, { reason });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not void this purchase.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">
          Void purchase — {purchase.supplier?.name ?? "Supplier"}
        </h2>
        <p className="mb-3 text-xs text-neutral-500">
          Reverses the stock quantity this purchase brought in and cancels any amount still due. This does
          not change the item&apos;s current average cost per unit. Can&apos;t be undone, and can&apos;t be
          done once a payment has been recorded against it.
        </p>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Reason</span>
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="input"
              placeholder="e.g. Duplicate entry, wrong quantity"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button disabled={saving} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60">
              {saving ? "Voiding…" : "Void purchase"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier dues tab
// ---------------------------------------------------------------------------

function SupplierDuesTab({ slug, canManageAccountBooks }: { slug: string; canManageAccountBooks: boolean }) {
  const [report, setReport] = useState<SupplierDueReport | null>(null);
  const [status, setStatus] = useState<"all" | "overdue" | "due_today" | "due_this_week">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payingRow, setPayingRow] = useState<SupplierDueRow | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const res = await apiGet<SupplierDueReport>(`${base(slug)}/suppliers/due-report?status=${status}`);
      setReport(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the supplier due report.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, status]);

  if (loading) return <p className="text-sm text-neutral-500">Loading supplier dues…</p>;
  if (!report) return error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-neutral-200 bg-white p-3">
          <p className="text-xs text-neutral-500">Total due</p>
          <p className="text-lg font-semibold text-neutral-900">{formatNPR(report.totalDueInPaisa)}</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-600">Overdue</p>
          <p className="text-lg font-semibold text-red-700">{formatNPR(report.overdueInPaisa)}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-600">Due today</p>
          <p className="text-lg font-semibold text-amber-700">{formatNPR(report.dueTodayInPaisa)}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-3">
          <p className="text-xs text-neutral-500">Due this week</p>
          <p className="text-lg font-semibold text-neutral-900">{formatNPR(report.dueThisWeekInPaisa)}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["all", "overdue", "due_today", "due_this_week"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              status === s ? "bg-orange-600 text-white" : "bg-neutral-100 text-neutral-600"
            }`}
          >
            {s === "all" ? "All" : s === "overdue" ? "Overdue" : s === "due_today" ? "Due today" : "Due this week"}
          </button>
        ))}
      </div>

      {report.supplierWise.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Outstanding</th>
                <th className="px-3 py-2">Overdue</th>
                <th className="px-3 py-2">Purchases</th>
              </tr>
            </thead>
            <tbody>
              {report.supplierWise.map((s) => (
                <tr key={s.supplierId ?? "unknown"} className="border-t border-neutral-100">
                  <td className="px-3 py-2 font-medium text-neutral-900">{s.supplierName}</td>
                  <td className="px-3 py-2">{formatNPR(s.outstandingInPaisa)}</td>
                  <td className="px-3 py-2 text-red-700">{s.overdueInPaisa > 0 ? formatNPR(s.overdueInPaisa) : "—"}</td>
                  <td className="px-3 py-2 text-neutral-500">{s.purchaseCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Invoice</th>
              <th className="px-3 py-2">Due date</th>
              <th className="px-3 py-2">Outstanding</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                  No outstanding supplier dues in this view.
                </td>
              </tr>
            )}
            {report.rows.map((r) => (
              <tr key={r.purchaseId} className="border-t border-neutral-100">
                <td className="px-3 py-2 font-medium text-neutral-900">{r.supplierName ?? "Unknown"}</td>
                <td className="px-3 py-2 text-neutral-500">{r.invoiceNumber || "—"}</td>
                <td className={`px-3 py-2 ${r.isOverdue ? "font-medium text-red-700" : "text-neutral-500"}`}>
                  {r.dueDate ? formatDate(r.dueDate, dateSystem) : "—"}
                  {r.isOverdue && " (overdue)"}
                </td>
                <td className="px-3 py-2">{formatNPR(r.outstandingInPaisa)}</td>
                <td className="px-3 py-2 text-right">
                  {canManageAccountBooks && (
                    <button
                      onClick={() => setPayingRow(r)}
                      className="text-xs font-medium text-orange-700 hover:underline"
                    >
                      Record payment
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {payingRow && (
        <RecordPaymentModal
          slug={slug}
          purchase={{
            id: payingRow.purchaseId,
            invoiceNumber: payingRow.invoiceNumber,
            totalInPaisa: payingRow.totalInPaisa,
            notes: null,
            createdAt: payingRow.createdAt,
            isCredit: true,
            dueDate: payingRow.dueDate,
            isVoided: false,
            supplier: payingRow.supplierName
              ? { id: payingRow.supplierId ?? "", name: payingRow.supplierName, phone: null, address: null, notes: null, isActive: true }
              : null,
            items: [],
            ledgerEntry: {
              id: payingRow.ledgerEntryId,
              amountInPaisa: payingRow.totalInPaisa,
              dueStatus: "outstanding",
              settledAmountInPaisa: payingRow.settledAmountInPaisa,
              isVoided: false,
            },
          }}
          onClose={() => setPayingRow(null)}
          onSaved={() => {
            setPayingRow(null);
            load();
          }}
        />
      )}
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
  const [isCredit, setIsCredit] = useState(false);
  const [dueDate, setDueDate] = useState("");
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
        isCredit,
        dueDate: isCredit && dueDate ? dueDate : null,
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
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input type="checkbox" checked={isCredit} onChange={(e) => setIsCredit(e.target.checked)} />
          Bought on credit (supplier due)
        </label>
        {isCredit && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Due date (optional)</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="input"
            />
          </label>
        )}
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

// ---------------------------------------------------------------------------
// Stock transfers tab (Commercial Launch Phase A.7 — Stock Transfer)
// ---------------------------------------------------------------------------

const STOCK_TRANSFER_STATUS_LABELS: Record<StockTransferStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  dispatched: "Dispatched",
  received: "Received",
  cancelled: "Cancelled",
};

function StockTransferStatusBadge({ status }: { status: StockTransferStatus }) {
  const cls =
    status === "requested"
      ? "bg-neutral-100 text-neutral-700"
      : status === "approved"
        ? "bg-blue-50 text-blue-700"
        : status === "dispatched"
          ? "bg-amber-50 text-amber-700"
          : status === "received"
            ? "bg-green-50 text-green-700"
            : "bg-red-50 text-red-700";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {STOCK_TRANSFER_STATUS_LABELS[status]}
    </span>
  );
}

function StockTransfersTab({ slug }: { slug: string }) {
  const { branches } = useBranchSelection();
  const [transfers, setTransfers] = useState<StockTransferSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | StockTransferStatus>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const qs = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const res = await apiGet<{ stockTransfers: StockTransferSummary[] }>(`${base(slug)}/stock-transfers${qs}`);
      setTransfers(res.stockTransfers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load stock transfers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, statusFilter]);

  function branchName(branchId: string) {
    return branches.find((b) => b.id === branchId)?.name ?? "—";
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading stock transfers…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {(["all", "requested", "approved", "dispatched", "received", "cancelled"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                statusFilter === s ? "bg-orange-600 text-white" : "bg-neutral-100 text-neutral-600"
              }`}
            >
              {s === "all" ? "All" : STOCK_TRANSFER_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {branches.length > 1 && (
          <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
            {showCreate ? "Cancel" : "+ New transfer"}
          </button>
        )}
      </div>

      {branches.length <= 1 && <p className="text-sm text-neutral-500">Stock transfers need at least two branches.</p>}

      {showCreate && (
        <CreateStockTransferForm
          slug={slug}
          onCreated={(transfer) => {
            setShowCreate(false);
            load();
            setViewingId(transfer.id);
          }}
        />
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Requested</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {transfers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                  No stock transfers in this view.
                </td>
              </tr>
            )}
            {transfers.map((t) => (
              <tr key={t.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 font-medium text-neutral-900">{branchName(t.fromBranchId)}</td>
                <td className="px-3 py-2 font-medium text-neutral-900">{branchName(t.toBranchId)}</td>
                <td className="px-3 py-2">
                  <StockTransferStatusBadge status={t.status} />
                </td>
                <td className="px-3 py-2 text-neutral-500">{formatDate(t.createdAt, dateSystem, { withTime: true })}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setViewingId(t.id)} className="text-xs font-medium text-orange-700 hover:underline">
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewingId && (
        <StockTransferDetailModal
          slug={slug}
          transferId={viewingId}
          onClose={() => setViewingId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function CreateStockTransferForm({
  slug,
  onCreated,
}: {
  slug: string;
  onCreated: (transfer: StockTransferSummary) => void;
}) {
  const { branches } = useBranchSelection();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [fromBranchId, setFromBranchId] = useState(branches[0]?.id ?? "");
  const [toBranchId, setToBranchId] = useState(branches[1]?.id ?? branches[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ inventoryItemId: string; quantity: string }[]>([
    { inventoryItemId: "", quantity: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ inventoryItems: InventoryItem[] }>(`${base(slug)}/inventory-items`)
      .then((res) => setItems(res.inventoryItems))
      .catch(() => {});
  }, [slug]);

  function updateLine(index: number, patch: Partial<{ inventoryItemId: string; quantity: string }>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { inventoryItemId: "", quantity: "" }]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fromBranchId || !toBranchId) {
      setError("Select both a source and destination branch.");
      return;
    }
    if (fromBranchId === toBranchId) {
      setError("The source and destination branch must be different.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<{ transfer: StockTransferSummary }>(`${base(slug)}/stock-transfers`, {
        fromBranchId,
        toBranchId,
        notes,
        items: lines
          .filter((l) => l.inventoryItemId && l.quantity)
          .map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: Number(l.quantity) })),
      });
      onCreated(res.transfer);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this transfer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">From branch</span>
          <select required value={fromBranchId} onChange={(e) => setFromBranchId(e.target.value)} className="input">
            <option value="" disabled>
              Select a branch
            </option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">To branch</span>
          <select required value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} className="input">
            <option value="" disabled>
              Select a branch
            </option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Notes (optional)</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input"
            placeholder="e.g. Branch B ran low on rice"
          />
        </label>
      </div>

      <div className="mt-3 space-y-2">
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-[1fr_100px_auto] items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-neutral-600">Item</span>
              <select
                required
                value={line.inventoryItemId}
                onChange={(e) => updateLine(i, { inventoryItemId: e.target.value })}
                className="input"
              >
                <option value="" disabled>
                  Select an item
                </option>
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
            <button
              type="button"
              onClick={() => removeLine(i)}
              disabled={lines.length === 1}
              className="btn-secondary disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={addLine} className="text-xs font-medium text-orange-700 hover:underline">
          + Add another item
        </button>
      </div>

      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Requesting…" : "Request transfer"}
      </button>
    </form>
  );
}

function StockTransferDetailModal({
  slug,
  transferId,
  onClose,
  onChanged,
}: {
  slug: string;
  transferId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { branches } = useBranchSelection();
  const dateSystem = useDateSystem();
  const [detail, setDetail] = useState<StockTransferDetail | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [receiveDrafts, setReceiveDrafts] = useState<Record<string, { quantity: string; note: string }>>({});
  const [approving, setApproving] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    try {
      const [detailRes, itemsRes] = await Promise.all([
        apiGet<StockTransferDetail>(`${base(slug)}/stock-transfers/${transferId}`),
        apiGet<{ inventoryItems: InventoryItem[] }>(`${base(slug)}/inventory-items`),
      ]);
      setDetail(detailRes);
      setItems(itemsRes.inventoryItems);
      const drafts: Record<string, { quantity: string; note: string }> = {};
      for (const line of detailRes.items) {
        drafts[line.id] = { quantity: String(milliunitsToUnits(line.quantityMilliunits)), note: "" };
      }
      setReceiveDrafts(drafts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this transfer.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferId]);

  function itemInfo(inventoryItemId: string) {
    return items.find((i) => i.id === inventoryItemId);
  }

  async function doApprove() {
    setApproving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-transfers/${transferId}/approve`, {});
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not approve this transfer.");
    } finally {
      setApproving(false);
    }
  }

  async function doDispatch() {
    setDispatching(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-transfers/${transferId}/dispatch`, {});
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not dispatch this transfer.");
    } finally {
      setDispatching(false);
    }
  }

  async function doReceive() {
    setReceiving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-transfers/${transferId}/receive`, {
        items: Object.entries(receiveDrafts).map(([stockTransferItemId, draft]) => ({
          stockTransferItemId,
          receivedQuantity: draft.quantity === "" ? 0 : Number(draft.quantity),
          note: draft.note,
        })),
      });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not receive this transfer.");
    } finally {
      setReceiving(false);
    }
  }

  async function doCancel(e: React.FormEvent) {
    e.preventDefault();
    setCancelling(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-transfers/${transferId}/cancel`, { reason: cancelReason });
      setShowCancel(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel this transfer.");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4 shadow-xl">
        {loading && <p className="text-sm text-neutral-500">Loading…</p>}
        {!loading && detail && (
          <>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">
                  {branches.find((b) => b.id === detail.transfer.fromBranchId)?.name ?? "Branch"} →{" "}
                  {branches.find((b) => b.id === detail.transfer.toBranchId)?.name ?? "Branch"}
                </h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Requested {formatDate(detail.transfer.createdAt, dateSystem, { withTime: true })}
                  {detail.transfer.notes ? ` — ${detail.transfer.notes}` : ""}
                </p>
              </div>
              <StockTransferStatusBadge status={detail.transfer.status} />
            </div>

            {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

            {detail.transfer.status === "cancelled" && (
              <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                Cancelled — {detail.transfer.cancellationReason}.
              </p>
            )}
            {detail.transfer.status === "received" && (
              <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800">
                Received
                {detail.transfer.receivedAt ? ` ${formatDate(detail.transfer.receivedAt, dateSystem, { withTime: true })}` : ""}
                {" "}
                — stock has moved to the destination branch.
              </p>
            )}
            {detail.transfer.status === "dispatched" && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Dispatched — stock has left the source branch and is in transit. Confirm what actually arrives
                below.
              </p>
            )}

            <div className="overflow-x-auto rounded-xl border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Requested</th>
                    <th className="px-3 py-2">{detail.transfer.status === "dispatched" ? "Received" : "Arrived"}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((row) => {
                    const info = itemInfo(row.inventoryItemId);
                    const unit = info?.unit ?? "piece";
                    return (
                      <tr key={row.id} className="border-t border-neutral-100 align-top">
                        <td className="px-3 py-2 font-medium text-neutral-900">{info?.name ?? "Unknown item"}</td>
                        <td className="px-3 py-2 text-neutral-500">{formatQuantity(row.quantityMilliunits, unit)}</td>
                        <td className="px-3 py-2">
                          {detail.transfer.status === "dispatched" ? (
                            <div className="space-y-1">
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                value={receiveDrafts[row.id]?.quantity ?? ""}
                                onChange={(e) =>
                                  setReceiveDrafts((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], quantity: e.target.value },
                                  }))
                                }
                                className="input w-24"
                              />
                              <input
                                value={receiveDrafts[row.id]?.note ?? ""}
                                onChange={(e) =>
                                  setReceiveDrafts((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], note: e.target.value },
                                  }))
                                }
                                placeholder="Note if different (optional)"
                                className="input w-40 text-xs"
                              />
                            </div>
                          ) : row.receivedQuantityMilliunits === null ? (
                            "—"
                          ) : (
                            <span
                              className={
                                row.receivedQuantityMilliunits < row.quantityMilliunits
                                  ? "text-red-700"
                                  : "text-neutral-700"
                              }
                            >
                              {formatQuantity(row.receivedQuantityMilliunits, unit)}
                            </span>
                          )}
                          {row.note && detail.transfer.status !== "dispatched" && (
                            <p className="mt-0.5 text-xs text-neutral-400">{row.note}</p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-secondary">
                Close
              </button>
              {(detail.transfer.status === "requested" || detail.transfer.status === "approved") && !showCancel && (
                <button
                  type="button"
                  onClick={() => setShowCancel(true)}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                >
                  Cancel transfer
                </button>
              )}
              {detail.transfer.status === "requested" && (
                <button type="button" disabled={approving} onClick={doApprove} className="btn-primary disabled:opacity-50">
                  {approving ? "Approving…" : "Approve"}
                </button>
              )}
              {detail.transfer.status === "approved" && (
                <button type="button" disabled={dispatching} onClick={doDispatch} className="btn-primary disabled:opacity-50">
                  {dispatching ? "Dispatching…" : "Dispatch"}
                </button>
              )}
              {detail.transfer.status === "dispatched" && (
                <button type="button" disabled={receiving} onClick={doReceive} className="btn-primary disabled:opacity-50">
                  {receiving ? "Receiving…" : "Confirm receive"}
                </button>
              )}
            </div>

            {showCancel && (
              <form onSubmit={doCancel} className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Reason for cancelling</span>
                  <input
                    required
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    className="input"
                    placeholder="e.g. No longer needed"
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowCancel(false)} className="btn-secondary">
                    Back
                  </button>
                  <button
                    disabled={cancelling}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {cancelling ? "Cancelling…" : "Confirm cancel"}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stock counts tab (Commercial Launch Phase A.6 — Physical Stock Count)
// ---------------------------------------------------------------------------

const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, string> = {
  open: "Open",
  pending_approval: "Pending approval",
  applied: "Applied",
  rejected: "Rejected",
};

function StockCountStatusBadge({ status }: { status: StockCountStatus }) {
  const cls =
    status === "open"
      ? "bg-neutral-100 text-neutral-700"
      : status === "pending_approval"
        ? "bg-amber-50 text-amber-700"
        : status === "applied"
          ? "bg-green-50 text-green-700"
          : "bg-red-50 text-red-700";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {STOCK_COUNT_STATUS_LABELS[status]}
    </span>
  );
}

function StockCountsTab({ slug, canApproveStockCount }: { slug: string; canApproveStockCount: boolean }) {
  const { branches } = useBranchSelection();
  const [counts, setCounts] = useState<StockCountSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | StockCountStatus>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const qs = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const res = await apiGet<{ stockCounts: StockCountSummary[] }>(`${base(slug)}/stock-counts${qs}`);
      setCounts(res.stockCounts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load stock counts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, statusFilter]);

  function branchName(branchId: string) {
    return branches.find((b) => b.id === branchId)?.name ?? "—";
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading stock counts…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {(["all", "open", "pending_approval", "applied", "rejected"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                statusFilter === s ? "bg-orange-600 text-white" : "bg-neutral-100 text-neutral-600"
              }`}
            >
              {s === "all" ? "All" : STOCK_COUNT_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
          {showCreate ? "Cancel" : "+ New count"}
        </button>
      </div>

      {showCreate && (
        <CreateStockCountForm
          slug={slug}
          onCreated={(count) => {
            setShowCreate(false);
            load();
            setViewingId(count.id);
          }}
        />
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Branch</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Submitted</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {counts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                  No stock counts in this view.
                </td>
              </tr>
            )}
            {counts.map((c) => (
              <tr key={c.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 font-medium text-neutral-900">{branchName(c.branchId)}</td>
                <td className="px-3 py-2">
                  <StockCountStatusBadge status={c.status} />
                  {c.hasLargeVariance && c.status === "pending_approval" && (
                    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                      Large variance
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-500">{formatDate(c.createdAt, dateSystem, { withTime: true })}</td>
                <td className="px-3 py-2 text-neutral-500">
                  {c.submittedAt ? formatDate(c.submittedAt, dateSystem, { withTime: true }) : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setViewingId(c.id)} className="text-xs font-medium text-orange-700 hover:underline">
                    {c.status === "open" ? "Continue" : "View"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewingId && (
        <StockCountDetailModal
          slug={slug}
          countId={viewingId}
          canApproveStockCount={canApproveStockCount}
          onClose={() => setViewingId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function CreateStockCountForm({
  slug,
  onCreated,
}: {
  slug: string;
  onCreated: (count: StockCountSummary) => void;
}) {
  const { branches, branchId, setBranchId } = useBranchSelection();
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branchId) {
      setError("No branch available to count.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<{ stockCount: StockCountSummary }>(`${base(slug)}/stock-counts`, {
        branchId,
        notes,
      });
      onCreated(res.stockCount);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a new stock count.");
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
            <span className="mb-1 block text-neutral-600">Branch</span>
            <select required value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Notes (optional)</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input"
            placeholder="e.g. Monthly count — dry storage"
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        Add items and record what you physically counted next. Submitting auto-applies the result unless a
        line&apos;s variance is large enough to need sign-off first.
      </p>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Starting…" : "Start count"}
      </button>
    </form>
  );
}

function StockCountDetailModal({
  slug,
  countId,
  canApproveStockCount,
  onClose,
  onChanged,
}: {
  slug: string;
  countId: string;
  canApproveStockCount: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { branches } = useBranchSelection();
  const dateSystem = useDateSystem();
  const [detail, setDetail] = useState<StockCountDetail | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addItemId, setAddItemId] = useState("");
  const [addQty, setAddQty] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editNote, setEditNote] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  async function load() {
    try {
      const [detailRes, itemsRes] = await Promise.all([
        apiGet<StockCountDetail>(`${base(slug)}/stock-counts/${countId}`),
        apiGet<{ inventoryItems: InventoryItem[] }>(`${base(slug)}/inventory-items`),
      ]);
      setDetail(detailRes);
      setItems(itemsRes.inventoryItems);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this stock count.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countId]);

  function itemInfo(inventoryItemId: string) {
    return items.find((i) => i.id === inventoryItemId);
  }

  const addableItems = items.filter(
    (i) => i.isActive && !detail?.items.some((li) => li.inventoryItemId === i.id),
  );

  async function submitAddItem(e: React.FormEvent) {
    e.preventDefault();
    if (!addItemId) return;
    setAdding(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-counts/${countId}/items`, {
        inventoryItemId: addItemId,
        physicalQuantity: addQty === "" ? null : Number(addQty),
      });
      setAddItemId("");
      setAddQty("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this item.");
    } finally {
      setAdding(false);
    }
  }

  function startEdit(row: StockCountItemRow) {
    setEditingItemId(row.id);
    setEditValue(row.physicalQuantityMilliunits === null ? "" : String(milliunitsToUnits(row.physicalQuantityMilliunits)));
    setEditNote(row.note ?? "");
  }

  async function saveEdit(itemRowId: string) {
    if (editValue === "") return;
    setSavingEdit(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/stock-counts/${countId}/items/${itemRowId}`, {
        physicalQuantity: Number(editValue),
        note: editNote,
      });
      setEditingItemId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this count.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function doSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-counts/${countId}/submit`, {});
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit this count.");
    } finally {
      setSubmitting(false);
    }
  }

  async function doApprove() {
    setApproving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-counts/${countId}/approve`, {});
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not approve this count.");
    } finally {
      setApproving(false);
    }
  }

  async function doReject(e: React.FormEvent) {
    e.preventDefault();
    setRejecting(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/stock-counts/${countId}/reject`, { reason: rejectReason });
      setShowReject(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject this count.");
    } finally {
      setRejecting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4 shadow-xl">
        {loading && <p className="text-sm text-neutral-500">Loading…</p>}
        {!loading && detail && (
          <>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">
                  Stock count — {branches.find((b) => b.id === detail.stockCount.branchId)?.name ?? "Branch"}
                </h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Started {formatDate(detail.stockCount.createdAt, dateSystem, { withTime: true })}
                  {detail.stockCount.notes ? ` — ${detail.stockCount.notes}` : ""}
                </p>
              </div>
              <StockCountStatusBadge status={detail.stockCount.status} />
            </div>

            {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

            {detail.stockCount.status === "pending_approval" && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                One or more lines vary from the system quantity by more than the auto-apply threshold, so this
                count needs sign-off before it changes stock.
                {!canApproveStockCount && " Ask a manager or accountant to review it."}
              </p>
            )}
            {detail.stockCount.status === "rejected" && (
              <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                Rejected — {detail.stockCount.rejectionReason}. No stock was changed.
              </p>
            )}
            {detail.stockCount.status === "applied" && (
              <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800">
                Applied
                {detail.stockCount.appliedAt ? ` ${formatDate(detail.stockCount.appliedAt, dateSystem, { withTime: true })}` : ""}
                {" "}
                — every line&apos;s variance has been written to the stock ledger.
              </p>
            )}

            <div className="overflow-x-auto rounded-xl border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">System</th>
                    <th className="px-3 py-2">Physical</th>
                    <th className="px-3 py-2">Variance</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                        No items added yet.
                      </td>
                    </tr>
                  )}
                  {detail.items.map((row) => {
                    const info = itemInfo(row.inventoryItemId);
                    const unit = info?.unit ?? "piece";
                    const isEditing = editingItemId === row.id;
                    return (
                      <tr key={row.id} className="border-t border-neutral-100 align-top">
                        <td className="px-3 py-2 font-medium text-neutral-900">
                          {info?.name ?? "Unknown item"}
                          {row.isLarge && (
                            <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                              Large
                            </span>
                          )}
                          {row.note && !isEditing && <p className="mt-0.5 text-xs text-neutral-400">{row.note}</p>}
                        </td>
                        <td className="px-3 py-2 text-neutral-500">{formatQuantity(row.systemQuantityMilliunits, unit)}</td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <div className="space-y-1">
                              <input
                                autoFocus
                                type="number"
                                min="0"
                                step="0.001"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="input w-24"
                              />
                              <input
                                value={editNote}
                                onChange={(e) => setEditNote(e.target.value)}
                                placeholder="Note (optional)"
                                className="input w-40 text-xs"
                              />
                            </div>
                          ) : row.physicalQuantityMilliunits === null ? (
                            <span className="text-neutral-400">Not counted</span>
                          ) : (
                            formatQuantity(row.physicalQuantityMilliunits, unit)
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {row.varianceMilliunits === null ? (
                            "—"
                          ) : (
                            <span
                              className={
                                row.varianceMilliunits < 0
                                  ? "text-red-700"
                                  : row.varianceMilliunits > 0
                                    ? "text-green-700"
                                    : "text-neutral-500"
                              }
                            >
                              {row.varianceMilliunits > 0 ? "+" : ""}
                              {formatQuantity(row.varianceMilliunits, unit)}
                              {row.varianceValueInPaisa !== null && (
                                <span className="ml-1 text-xs text-neutral-400">({formatNPR(row.varianceValueInPaisa)})</span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {detail.stockCount.status === "open" &&
                            (isEditing ? (
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingItemId(null)}
                                  className="text-xs text-neutral-400 hover:underline"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={savingEdit || editValue === ""}
                                  onClick={() => saveEdit(row.id)}
                                  className="text-xs font-medium text-orange-700 hover:underline disabled:opacity-50"
                                >
                                  Save
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => startEdit(row)}
                                className="text-xs font-medium text-orange-700 hover:underline"
                              >
                                {row.physicalQuantityMilliunits === null ? "Count" : "Edit"}
                              </button>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {detail.stockCount.status === "open" && (
              <form onSubmit={submitAddItem} className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  <span className="mb-1 block text-neutral-600">Add item</span>
                  <select value={addItemId} onChange={(e) => setAddItemId(e.target.value)} className="input" required>
                    <option value="" disabled>
                      Select an item
                    </option>
                    {addableItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({i.unit})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-neutral-600">Physical qty (optional now)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={addQty}
                    onChange={(e) => setAddQty(e.target.value)}
                    className="input w-32"
                  />
                </label>
                <button disabled={adding || !addItemId} className="btn-secondary">
                  {adding ? "Adding…" : "Add"}
                </button>
              </form>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-secondary">
                Close
              </button>
              {detail.stockCount.status === "open" && (
                <button
                  type="button"
                  disabled={submitting || detail.items.length === 0}
                  onClick={doSubmit}
                  className="btn-primary disabled:opacity-50"
                >
                  {submitting ? "Submitting…" : "Submit count"}
                </button>
              )}
              {detail.stockCount.status === "pending_approval" && canApproveStockCount && !showReject && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowReject(true)}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    Reject
                  </button>
                  <button type="button" disabled={approving} onClick={doApprove} className="btn-primary disabled:opacity-50">
                    {approving ? "Approving…" : "Approve"}
                  </button>
                </>
              )}
            </div>

            {showReject && (
              <form onSubmit={doReject} className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Reason for rejecting</span>
                  <input
                    required
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    className="input"
                    placeholder="e.g. Recount needed, numbers look off"
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowReject(false)} className="btn-secondary">
                    Cancel
                  </button>
                  <button
                    disabled={rejecting}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {rejecting ? "Rejecting…" : "Confirm reject"}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
