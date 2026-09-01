"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";

type Coupon = {
  id: string;
  code: string;
  discountType: "percentage" | "flat";
  discountValue: number; // basis points for percentage, paisa for flat
  maxDiscountInPaisa: number | null;
  minOrderSubtotalInPaisa: number | null;
  usageLimit: number | null;
  usageCount: number;
  // Gap-audit follow-up (P1 revenue leakage) — the four newer restriction
  // types. branchIds/menuItemIds/categoryIds: empty array = unrestricted
  // (matches every branch/item), same convention the API uses.
  perCustomerLimit: number | null;
  firstOrderOnly: boolean;
  branchIds: string[];
  menuItemIds: string[];
  categoryIds: string[];
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
};

type Branch = { id: string; name: string };
type Category = { id: string; name: string };
type MenuItem = { id: string; name: string; categoryId: string };

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatDiscount(c: Coupon) {
  return c.discountType === "percentage"
    ? `${(c.discountValue / 100).toFixed(c.discountValue % 100 === 0 ? 0 : 2)}%`
    : formatNPR(c.discountValue);
}

function isExpired(c: Coupon) {
  return Boolean(c.expiresAt && new Date(c.expiresAt) < new Date());
}

export function CouponsBoard({ slug }: { slug: string }) {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [couponsRes, branchesRes, categoriesRes, menuItemsRes] = await Promise.all([
        apiGet<{ coupons: Coupon[] }>(`${base(slug)}/coupons`),
        apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`),
        apiGet<{ categories: Category[] }>(`${base(slug)}/categories`),
        apiGet<{ menuItems: MenuItem[] }>(`${base(slug)}/menu-items`),
      ]);
      setCoupons(couponsRes.coupons);
      setBranches(branchesRes.branches);
      setCategories(categoriesRes.categories);
      setMenuItems(menuItemsRes.menuItems);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load coupons.");
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
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500">
          {coupons.length} coupon{coupons.length === 1 ? "" : "s"}
        </p>
        <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
          {showAdd ? "Cancel" : "+ New coupon"}
        </button>
      </div>

      {showAdd && (
        <AddCouponForm
          slug={slug}
          branches={branches}
          categories={categories}
          menuItems={menuItems}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading coupons…</p>
      ) : coupons.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-400">
          No coupons yet. Create one to let staff redeem it at checkout.
        </p>
      ) : (
        <div className="space-y-2">
          {coupons.map((c) => (
            <CouponRow
              key={c.id}
              slug={slug}
              coupon={c}
              branches={branches}
              categories={categories}
              menuItems={menuItems}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared restriction pickers — branch / category / menu-item multi-select.
// Gap-audit follow-up (P1 revenue leakage). Every restriction defaults to
// "unrestricted" (nothing checked) so a plain coupon needs no extra clicks
// — only staff who want to LIMIT a coupon touch these at all.
// ---------------------------------------------------------------------------

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function RestrictionPickers({
  branches,
  categories,
  menuItems,
  branchIds,
  setBranchIds,
  categoryIds,
  setCategoryIds,
  menuItemIds,
  setMenuItemIds,
}: {
  branches: Branch[];
  categories: Category[];
  menuItems: MenuItem[];
  branchIds: string[];
  setBranchIds: (ids: string[]) => void;
  categoryIds: string[];
  setCategoryIds: (ids: string[]) => void;
  menuItemIds: string[];
  setMenuItemIds: (ids: string[]) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {branches.length > 1 && (
        <div className="text-sm">
          <span className="mb-1 block text-neutral-600">Branches (none checked = all branches)</span>
          <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 p-2">
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-xs text-neutral-700">
                <input
                  type="checkbox"
                  checked={branchIds.includes(b.id)}
                  onChange={() => setBranchIds(toggleId(branchIds, b.id))}
                />
                {b.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="text-sm">
        <span className="mb-1 block text-neutral-600">Categories (none checked = all items)</span>
        <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 p-2">
          {categories.length === 0 ? (
            <p className="text-xs text-neutral-400">No categories yet.</p>
          ) : (
            categories.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs text-neutral-700">
                <input
                  type="checkbox"
                  checked={categoryIds.includes(c.id)}
                  onChange={() => setCategoryIds(toggleId(categoryIds, c.id))}
                />
                {c.name}
              </label>
            ))
          )}
        </div>
      </div>
      <div className="text-sm">
        <span className="mb-1 block text-neutral-600">Menu items (none checked = all items)</span>
        <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 p-2">
          {menuItems.length === 0 ? (
            <p className="text-xs text-neutral-400">No menu items yet.</p>
          ) : (
            menuItems.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-xs text-neutral-700">
                <input
                  type="checkbox"
                  checked={menuItemIds.includes(m.id)}
                  onChange={() => setMenuItemIds(toggleId(menuItemIds, m.id))}
                />
                {m.name}
              </label>
            ))
          )}
        </div>
      </div>
      {(categoryIds.length > 0 || menuItemIds.length > 0) && (
        <p className="sm:col-span-3 text-xs text-neutral-500">
          The discount will apply only to the selected items/categories&rsquo; share of the order, not the whole
          bill.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function AddCouponForm({
  slug,
  branches,
  categories,
  menuItems,
  onAdded,
}: {
  slug: string;
  branches: Branch[];
  categories: Category[];
  menuItems: MenuItem[];
  onAdded: () => void;
}) {
  const [code, setCode] = useState("");
  const [discountType, setDiscountType] = useState<"percentage" | "flat">("percentage");
  const [discountPercent, setDiscountPercent] = useState("10");
  const [discountFlatAmount, setDiscountFlatAmount] = useState("");
  const [maxDiscount, setMaxDiscount] = useState("");
  const [minOrderSubtotal, setMinOrderSubtotal] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [perCustomerLimit, setPerCustomerLimit] = useState("");
  const [firstOrderOnly, setFirstOrderOnly] = useState(false);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [menuItemIds, setMenuItemIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/coupons`, {
        code,
        discountType,
        discountPercent: discountType === "percentage" ? Number(discountPercent) : undefined,
        discountFlatAmount: discountType === "flat" ? Number(discountFlatAmount) : undefined,
        maxDiscount: discountType === "percentage" && maxDiscount ? Number(maxDiscount) : undefined,
        minOrderSubtotal: minOrderSubtotal ? Number(minOrderSubtotal) : undefined,
        usageLimit: usageLimit ? Number(usageLimit) : undefined,
        perCustomerLimit: perCustomerLimit ? Number(perCustomerLimit) : undefined,
        firstOrderOnly: firstOrderOnly || undefined,
        branchIds: branchIds.length > 0 ? branchIds : undefined,
        categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
        menuItemIds: menuItemIds.length > 0 ? menuItemIds : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        note: note || undefined,
      });
      setCode("");
      setDiscountPercent("10");
      setDiscountFlatAmount("");
      setMaxDiscount("");
      setMinOrderSubtotal("");
      setUsageLimit("");
      setPerCustomerLimit("");
      setFirstOrderOnly(false);
      setBranchIds([]);
      setCategoryIds([]);
      setMenuItemIds([]);
      setExpiresAt("");
      setNote("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create coupon.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Code</span>
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="input"
            placeholder="SAVE20"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Type</span>
          <select
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value as "percentage" | "flat")}
            className="input"
          >
            <option value="percentage">Percentage off</option>
            <option value="flat">Flat amount off</option>
          </select>
        </label>
        {discountType === "percentage" ? (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Percent off</span>
            <input
              required
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={discountPercent}
              onChange={(e) => setDiscountPercent(e.target.value)}
              className="input"
            />
          </label>
        ) : (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Flat amount (Rs.)</span>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={discountFlatAmount}
              onChange={(e) => setDiscountFlatAmount(e.target.value)}
              className="input"
            />
          </label>
        )}
        {discountType === "percentage" && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Max discount (Rs., optional)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={maxDiscount}
              onChange={(e) => setMaxDiscount(e.target.value)}
              className="input"
            />
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Min order subtotal (Rs., optional)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={minOrderSubtotal}
            onChange={(e) => setMinOrderSubtotal(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Total usage limit (optional)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={usageLimit}
            onChange={(e) => setUsageLimit(e.target.value)}
            className="input"
            placeholder="Unlimited"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Uses per customer (optional)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={perCustomerLimit}
            onChange={(e) => setPerCustomerLimit(e.target.value)}
            className="input"
            placeholder="Unlimited"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Expires (optional)</span>
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="input"
          />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-neutral-700">
          <input type="checkbox" checked={firstOrderOnly} onChange={(e) => setFirstOrderOnly(e.target.checked)} />
          First order only (requires a linked customer)
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Note (optional, internal)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </label>
      </div>

      <div className="mt-4 border-t border-neutral-100 pt-4">
        <RestrictionPickers
          branches={branches}
          categories={categories}
          menuItems={menuItems}
          branchIds={branchIds}
          setBranchIds={setBranchIds}
          categoryIds={categoryIds}
          setCategoryIds={setCategoryIds}
          menuItemIds={menuItemIds}
          setMenuItemIds={setMenuItemIds}
        />
      </div>

      <div className="mt-4">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? "Creating…" : "Create coupon"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Row + inline edit
// ---------------------------------------------------------------------------

function CouponRow({
  slug,
  coupon,
  branches,
  categories,
  menuItems,
  onChanged,
}: {
  slug: string;
  coupon: Coupon;
  branches: Branch[];
  categories: Category[];
  menuItems: MenuItem[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = isExpired(coupon);
  const limitReached = coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit;

  async function toggleActive() {
    setTogglingActive(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/coupons/${coupon.id}`, { isActive: !coupon.isActive });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update coupon.");
    } finally {
      setTogglingActive(false);
    }
  }

  const branchNames = branches.filter((b) => coupon.branchIds.includes(b.id)).map((b) => b.name);
  const categoryNames = categories.filter((c) => coupon.categoryIds.includes(c.id)).map((c) => c.name);
  const menuItemCount = coupon.menuItemIds.length;

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-neutral-900">{coupon.code}</span>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
              {formatDiscount(coupon)} off
            </span>
            {!coupon.isActive && (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600">Inactive</span>
            )}
            {expired && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">Expired</span>
            )}
            {limitReached && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Limit reached</span>
            )}
            {coupon.firstOrderOnly && (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800">First order only</span>
            )}
            {coupon.perCustomerLimit !== null && (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800">
                {coupon.perCustomerLimit}/customer
              </span>
            )}
            {branchNames.length > 0 && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800">
                {branchNames.join(", ")} only
              </span>
            )}
            {(categoryNames.length > 0 || menuItemCount > 0) && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800">
                {[...categoryNames, menuItemCount > 0 ? `${menuItemCount} item${menuItemCount === 1 ? "" : "s"}` : null]
                  .filter(Boolean)
                  .join(", ")}{" "}
                only
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            Used {coupon.usageCount}
            {coupon.usageLimit !== null ? ` / ${coupon.usageLimit}` : ""}
            {coupon.minOrderSubtotalInPaisa !== null && (
              <> · Min order {formatNPR(coupon.minOrderSubtotalInPaisa)}</>
            )}
            {coupon.maxDiscountInPaisa !== null && (
              <> · Max discount {formatNPR(coupon.maxDiscountInPaisa)}</>
            )}
            {coupon.expiresAt && <> · Expires {new Date(coupon.expiresAt).toLocaleDateString()}</>}
            {coupon.note && <> · {coupon.note}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setEditing((v) => !v)} className="btn-secondary text-xs">
            {editing ? "Close" : "Edit"}
          </button>
          <button onClick={toggleActive} disabled={togglingActive} className="btn-secondary text-xs">
            {coupon.isActive ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
      {editing && (
        <div className="mt-4 border-t border-neutral-100 pt-4">
          <EditCouponForm
            slug={slug}
            coupon={coupon}
            branches={branches}
            categories={categories}
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

function EditCouponForm({
  slug,
  coupon,
  branches,
  categories,
  menuItems,
  onSaved,
}: {
  slug: string;
  coupon: Coupon;
  branches: Branch[];
  categories: Category[];
  menuItems: MenuItem[];
  onSaved: () => void;
}) {
  const [maxDiscount, setMaxDiscount] = useState(
    coupon.maxDiscountInPaisa !== null ? String(coupon.maxDiscountInPaisa / 100) : "",
  );
  const [minOrderSubtotal, setMinOrderSubtotal] = useState(
    coupon.minOrderSubtotalInPaisa !== null ? String(coupon.minOrderSubtotalInPaisa / 100) : "",
  );
  const [usageLimit, setUsageLimit] = useState(coupon.usageLimit !== null ? String(coupon.usageLimit) : "");
  const [perCustomerLimit, setPerCustomerLimit] = useState(
    coupon.perCustomerLimit !== null ? String(coupon.perCustomerLimit) : "",
  );
  const [firstOrderOnly, setFirstOrderOnly] = useState(coupon.firstOrderOnly);
  const [branchIds, setBranchIds] = useState<string[]>(coupon.branchIds);
  const [categoryIds, setCategoryIds] = useState<string[]>(coupon.categoryIds);
  const [menuItemIds, setMenuItemIds] = useState<string[]>(coupon.menuItemIds);
  const [expiresAt, setExpiresAt] = useState(coupon.expiresAt ? coupon.expiresAt.slice(0, 10) : "");
  const [note, setNote] = useState(coupon.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only fields that make sense to change after a code's been shared are
  // editable here (see updateCouponSchema's own comment) — code and
  // discount value/type stay fixed to avoid "the coupon changed after
  // someone screenshotted it" confusion. branchIds/categoryIds/menuItemIds
  // are ALWAYS sent as the complete replacement set (whole-state-replace,
  // same as the combo item editor) since they're pre-populated from the
  // coupon's current restrictions above.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/coupons/${coupon.id}`, {
        maxDiscount: maxDiscount ? Number(maxDiscount) : null,
        minOrderSubtotal: minOrderSubtotal ? Number(minOrderSubtotal) : null,
        usageLimit: usageLimit ? Number(usageLimit) : null,
        perCustomerLimit: perCustomerLimit ? Number(perCustomerLimit) : null,
        firstOrderOnly,
        branchIds,
        categoryIds,
        menuItemIds,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        note: note || null,
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
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        {coupon.discountType === "percentage" && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Max discount (Rs.)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={maxDiscount}
              onChange={(e) => setMaxDiscount(e.target.value)}
              className="input"
            />
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Min order subtotal (Rs.)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={minOrderSubtotal}
            onChange={(e) => setMinOrderSubtotal(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Total usage limit</span>
          <input
            type="number"
            min="1"
            step="1"
            value={usageLimit}
            onChange={(e) => setUsageLimit(e.target.value)}
            className="input"
            placeholder="Unlimited"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Uses per customer</span>
          <input
            type="number"
            min="1"
            step="1"
            value={perCustomerLimit}
            onChange={(e) => setPerCustomerLimit(e.target.value)}
            className="input"
            placeholder="Unlimited"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Expires</span>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="input" />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-neutral-700">
          <input type="checkbox" checked={firstOrderOnly} onChange={(e) => setFirstOrderOnly(e.target.checked)} />
          First order only
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </label>
      </div>

      <div className="border-t border-neutral-100 pt-3">
        <RestrictionPickers
          branches={branches}
          categories={categories}
          menuItems={menuItems}
          branchIds={branchIds}
          setBranchIds={setBranchIds}
          categoryIds={categoryIds}
          setCategoryIds={setCategoryIds}
          menuItemIds={menuItemIds}
          setMenuItemIds={setMenuItemIds}
        />
      </div>

      <button type="submit" disabled={saving} className="btn-primary">
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
