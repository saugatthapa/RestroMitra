"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api-client";
import { QrPosterButton } from "@/components/QrPosterButton";

type Table = {
  id: string;
  name: string;
  capacity: number | null;
  qrToken: string;
  isActive: boolean;
  branchId: string;
};

type Branch = { id: string; name: string; isActive: boolean };

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

export function TablesManager({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const [tables, setTables] = useState<Table[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchFilter, setBranchFilter] = useState(""); // "" = all branches
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  // Cache-busting query param per table — the QR image's URL is keyed by
  // table id, not by qrToken, so the browser's cached copy of that exact
  // URL would otherwise keep showing the OLD code's image after a
  // regenerate (the server-side image genuinely changed; nothing else did).
  const [qrCacheBust, setQrCacheBust] = useState<Record<string, number>>({});
  // Lazy initializer (not an effect) — order links are only meaningful in
  // the browser (need the actual host customers will hit), and this way
  // there's no synchronous setState-in-effect to trigger a second render.
  const [origin] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));

  async function loadTables(branchId: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = branchId ? `?branchId=${branchId}` : "";
      const [tablesRes, branchesRes] = await Promise.all([
        apiGet<{ tables: Table[] }>(`${base(slug)}/tables${qs}`),
        apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`),
      ]);
      setTables(tablesRes.tables);
      setBranches(branchesRes.branches);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load tables.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Mount-time (and slug/branch-filter-change-time) data fetch, not a
    // cascading-render loop — loadTables() only re-runs when one of its
    // own dependencies actually changes.
    loadTables(branchFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, branchFilter]);

  async function handleAddTable() {
    const name = window.prompt("Table name (e.g. Table 5, T-12)");
    if (!name || !name.trim()) return;
    const capacityStr = window.prompt("Seats at this table (optional)", "");
    const capacity =
      capacityStr && capacityStr.trim() !== "" ? Number(capacityStr) : undefined;
    if (capacity !== undefined && (Number.isNaN(capacity) || capacity < 1)) {
      alert("Capacity must be a positive number.");
      return;
    }
    setCreating(true);
    try {
      const res = await apiPost<{ table: Table }>(`${base(slug)}/tables`, {
        name,
        capacity,
        // Respect whichever branch is currently filtered to — otherwise an
        // unrestricted owner viewing "Dharan Branch" would have a new
        // table silently land on the main branch instead.
        branchId: branchFilter || undefined,
      });
      setTables((prev) => [...prev, res.table]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not create table.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(table: Table) {
    const name = window.prompt("Rename table", table.name);
    if (!name || !name.trim() || name === table.name) return;
    try {
      const res = await apiPatch<{ table: Table }>(`${base(slug)}/tables/${table.id}`, {
        name,
      });
      setTables((prev) => prev.map((t) => (t.id === table.id ? res.table : t)));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not rename table.");
    }
  }

  async function handleDeactivate(table: Table) {
    if (
      !window.confirm(
        `Deactivate "${table.name}"? Its QR code will stop accepting new orders.`,
      )
    )
      return;
    try {
      await apiDelete(`${base(slug)}/tables/${table.id}`);
      setTables((prev) => prev.filter((t) => t.id !== table.id));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not deactivate table.");
    }
  }

  async function handleRegenerateQr(table: Table) {
    if (
      !window.confirm(
        `Regenerate the QR code for "${table.name}"? The old code (any printed poster, ` +
          `bookmark, or screenshot of it) will immediately STOP working — customers must ` +
          `scan the new one. Use this if a code was leaked, photographed by the wrong ` +
          `person, or a poster went missing.`,
      )
    )
      return;
    setRegenerating(table.id);
    try {
      const res = await apiPost<{ table: Table }>(`${base(slug)}/tables/${table.id}/qr`, {});
      setTables((prev) => prev.map((t) => (t.id === table.id ? res.table : t)));
      setQrCacheBust((prev) => ({ ...prev, [table.id]: Date.now() }));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not regenerate the QR code.");
    } finally {
      setRegenerating(null);
    }
  }

  async function copyOrderLink(table: Table) {
    const url = `${origin}/order/${table.qrToken}`;
    try {
      await navigator.clipboard.writeText(url);
      alert("Order link copied to clipboard.");
    } catch {
      window.prompt("Copy this order link:", url);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading tables…</p>;
  }

  const activeTables = tables.filter((t) => t.isActive);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={handleAddTable} disabled={creating} className="btn-primary text-sm">
          + Table
        </button>
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mr-2 text-neutral-500">Branch</span>
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="input !w-auto"
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {activeTables.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No tables yet. Add one to generate its QR code — customers scan it to view your
          menu and place an order for that table.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {activeTables.map((table) => (
            <div
              key={table.id}
              className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">{table.name}</p>
                  {table.capacity != null && (
                    <p className="text-xs text-neutral-500">Seats {table.capacity}</p>
                  )}
                  {branches.length > 1 && (
                    <p className="text-xs text-neutral-400">{branchName(table.branchId)}</p>
                  )}
                </div>
              </div>

              {(() => {
                const qrUrl = `${base(slug)}/tables/${table.id}/qr${
                  qrCacheBust[table.id] ? `?v=${qrCacheBust[table.id]}` : ""
                }`;
                return (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qrUrl}
                      alt={`QR code for ${table.name}`}
                      width={140}
                      height={140}
                      className="my-3 h-[140px] w-[140px] rounded-lg border border-neutral-100"
                    />

                    <div className="flex flex-wrap gap-3 text-xs">
                      <a
                        href={qrUrl}
                        download={`${table.name.replace(/[^a-z0-9]+/gi, "-")}-qr.png`}
                        className="font-medium text-orange-600 hover:text-orange-700"
                      >
                        Download QR
                      </a>
                      <QrPosterButton
                        qrImageUrl={qrUrl}
                        restaurantName={restaurantName}
                        subtitle={table.name}
                        fileName={`${table.name.replace(/[^a-z0-9]+/gi, "-")}-poster.png`}
                        className="font-medium text-orange-600 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Download poster
                      </QrPosterButton>
                      <button
                        onClick={() => copyOrderLink(table)}
                        className="font-medium text-neutral-600 hover:text-neutral-900"
                      >
                        Copy order link
                      </button>
                      <button
                        onClick={() => handleRename(table)}
                        className="font-medium text-neutral-600 hover:text-neutral-900"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => handleRegenerateQr(table)}
                        disabled={regenerating === table.id}
                        className="font-medium text-neutral-600 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                        title="Invalidate the current QR code and issue a new one — use if a code was leaked or a poster went missing."
                      >
                        {regenerating === table.id ? "Regenerating…" : "Regenerate QR"}
                      </button>
                      <button
                        onClick={() => handleDeactivate(table)}
                        className="font-medium text-neutral-400 hover:text-red-600"
                      >
                        Deactivate
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
