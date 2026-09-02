"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api-client";
import {
  TABLE_STATUS_LABELS,
  TABLE_STATUS_COLORS,
  manualNextStatuses,
  type TableStatus,
} from "@/lib/table-status";

type FloorTable = {
  id: string;
  name: string;
  capacity: number | null;
  status: TableStatus;
  posX: number | null;
  posY: number | null;
  width: number;
  height: number;
  shape: "rectangle" | "circle" | "square";
  rotation: number;
  floorLabel: string | null;
  branchId: string;
  isActive: boolean;
};

type ActiveOrder = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalInPaisa: number;
  customerName: string | null;
  placedAt: string;
  // Commercial Launch Phase B.7 — Table Operations.
  isOnHold: boolean;
  holdReason: string | null;
};

type UpcomingReservation = {
  id: string;
  customerName: string;
  partySize: number;
  reservationTime: string;
};

type TableDetail = {
  table: FloorTable;
  activeOrders: ActiveOrder[];
  upcomingReservations: UpcomingReservation[];
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

// Sentinel used for tables with no floorLabel set — keeps a single default
// section instead of splitting "unlabelled" tables away from named ones.
const DEFAULT_FLOOR = "Main Floor";
const DRAG_THRESHOLD_PX = 4;

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function nextOpenSpot(existing: FloorTable[]): { x: number; y: number } {
  // Simple cascading placement for newly created tables — staff drag them
  // into their real position afterward, this just avoids stacking every
  // new table exactly on top of the last one.
  const count = existing.length;
  const col = count % 6;
  const row = Math.floor(count / 6);
  return { x: 24 + col * 140, y: 24 + row * 140 };
}

export function FloorPlanBoard({ slug }: { slug: string }) {
  const router = useRouter();
  const [tables, setTables] = useState<FloorTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState<string>(DEFAULT_FLOOR);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // Commercial Launch Phase B.7 — Table Operations UI state.
  const [transferringOrderId, setTransferringOrderId] = useState<string | null>(null);
  const [transferTargetTableId, setTransferTargetTableId] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeSourceTableId, setMergeSourceTableId] = useState("");
  const [tableOpBusy, setTableOpBusy] = useState(false);

  const dragState = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ tables: FloorTable[] }>(`${base(slug)}/tables`);
      setTables(res.tables.filter((t) => t.isActive));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the floor plan.");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    // Mount-time fetch — load() only changes identity when slug changes.
    load();
  }, [load]);

  const floors = useMemo(() => {
    const set = new Set<string>();
    for (const t of tables) set.add(t.floorLabel || DEFAULT_FLOOR);
    if (set.size === 0) set.add(DEFAULT_FLOOR);
    return Array.from(set).sort();
  }, [tables]);

  useEffect(() => {
    if (!floors.includes(activeFloor)) {
      setActiveFloor(floors[0]);
    }
  }, [floors, activeFloor]);

  const visibleTables = tables.filter((t) => (t.floorLabel || DEFAULT_FLOOR) === activeFloor);

  async function openDetail(tableId: string) {
    setSelectedTableId(tableId);
    setDetailLoading(true);
    try {
      const res = await apiGet<TableDetail>(`${base(slug)}/tables/${tableId}`);
      setDetail(res);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not load this table's details.");
      setSelectedTableId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedTableId(null);
    setDetail(null);
    setTransferringOrderId(null);
    setTransferTargetTableId("");
    setMerging(false);
    setMergeSourceTableId("");
  }

  async function changeStatus(tableId: string, status: TableStatus) {
    try {
      const res = await apiPatch<{ table: FloorTable }>(`${base(slug)}/tables/${tableId}/status`, {
        status,
      });
      setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, status: res.table.status } : t)));
      setDetail((prev) => (prev ? { ...prev, table: { ...prev.table, status: res.table.status } } : prev));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not change this table's status.");
    }
  }

  function openInPOS(tableId: string) {
    router.push(`/dashboard/pos?table=${tableId}`);
  }

  // -------------------------------------------------------------------
  // Commercial Launch Phase B.7 — Table Operations. Errors surface via
  // alert(), matching this file's existing convention (changeStatus,
  // handleAddTable) rather than introducing a different inline-error
  // pattern just for this feature.
  // -------------------------------------------------------------------

  async function refreshDetail(tableId: string) {
    try {
      const res = await apiGet<TableDetail>(`${base(slug)}/tables/${tableId}`);
      setDetail(res);
    } catch {
      // Best-effort refresh — the action itself already succeeded/failed
      // and reported its own error; a failed refresh just leaves stale
      // detail data until the user re-opens the panel.
    }
  }

  async function transferOrder(orderId: string) {
    if (!transferTargetTableId) return;
    setTableOpBusy(true);
    try {
      await apiPost(`${base(slug)}/orders/${orderId}/transfer`, { toTableId: transferTargetTableId });
      setTransferringOrderId(null);
      setTransferTargetTableId("");
      await load();
      if (selectedTableId) await refreshDetail(selectedTableId);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not transfer this order.");
    } finally {
      setTableOpBusy(false);
    }
  }

  async function mergeIntoCurrentTable() {
    if (!detail || !mergeSourceTableId) return;
    setTableOpBusy(true);
    try {
      await apiPost(`${base(slug)}/tables/${detail.table.id}/merge`, { fromTableId: mergeSourceTableId });
      setMerging(false);
      setMergeSourceTableId("");
      await load();
      await refreshDetail(detail.table.id);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not merge these tables.");
    } finally {
      setTableOpBusy(false);
    }
  }

  async function holdOrder(orderId: string) {
    const reason = window.prompt("Reason for holding this order (optional)", "") ?? "";
    setTableOpBusy(true);
    try {
      await apiPost(`${base(slug)}/orders/${orderId}/hold`, { reason });
      if (selectedTableId) await refreshDetail(selectedTableId);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not hold this order.");
    } finally {
      setTableOpBusy(false);
    }
  }

  async function resumeOrder(orderId: string) {
    setTableOpBusy(true);
    try {
      await apiPost(`${base(slug)}/orders/${orderId}/resume`, {});
      if (selectedTableId) await refreshDetail(selectedTableId);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not resume this order.");
    } finally {
      setTableOpBusy(false);
    }
  }

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
      const spot = nextOpenSpot(visibleTables);
      const res = await apiPost<{ table: FloorTable }>(`${base(slug)}/tables`, {
        name,
        capacity,
        floorLabel: activeFloor === DEFAULT_FLOOR ? undefined : activeFloor,
      });
      // Give the newly created table an initial floor-plan position — a
      // second call rather than folding into POST since table creation
      // and layout placement are separate concerns server-side (POST
      // doesn't accept posX/posY at all, only the update route does).
      const placed = await apiPatch<{ table: FloorTable }>(`${base(slug)}/tables/${res.table.id}`, {
        posX: spot.x,
        posY: spot.y,
      });
      setTables((prev) => [...prev, placed.table]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not create the table.");
    } finally {
      setCreating(false);
    }
  }

  function handleAddFloor() {
    const name = window.prompt("New floor/section name (e.g. Rooftop, Garden, 2nd Floor)");
    if (!name || !name.trim()) return;
    setActiveFloor(name.trim());
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, table: FloorTable) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      id: table.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: table.posX ?? 20,
      origY: table.posY ?? 20,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state) return;
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
      state.moved = true;
    }
    if (!state.moved) return;
    const nextX = Math.max(0, state.origX + dx);
    const nextY = Math.max(0, state.origY + dy);
    setTables((prev) => prev.map((t) => (t.id === state.id ? { ...t, posX: nextX, posY: nextY } : t)));
  };

  const handlePointerUp = async (e: React.PointerEvent<HTMLDivElement>, table: FloorTable) => {
    const state = dragState.current;
    dragState.current = null;
    if (!state || state.id !== table.id) return;

    if (!state.moved) {
      // A click, not a drag — open the detail panel.
      openDetail(table.id);
      return;
    }

    const current = tables.find((t) => t.id === state.id);
    if (!current) return;
    const myRect = { x: current.posX ?? 0, y: current.posY ?? 0, w: current.width, h: current.height };
    const collides = tables.some(
      (t) =>
        t.id !== current.id &&
        (t.floorLabel || DEFAULT_FLOOR) === activeFloor &&
        rectsOverlap(myRect, { x: t.posX ?? 0, y: t.posY ?? 0, w: t.width, h: t.height }),
    );

    if (collides) {
      // Prevent invalid overlaps "where practical" — snap back rather than
      // let two tables visually stack on the floor plan.
      setTables((prev) => prev.map((t) => (t.id === state.id ? { ...t, posX: state.origX, posY: state.origY } : t)));
      return;
    }

    try {
      await apiPatch(`${base(slug)}/tables/${state.id}`, { posX: myRect.x, posY: myRect.y });
    } catch (err) {
      setTables((prev) => prev.map((t) => (t.id === state.id ? { ...t, posX: state.origX, posY: state.origY } : t)));
      alert(err instanceof ApiError ? err.message : "Could not save this table's position.");
    }
  };

  if (loading) {
    return <p className="text-sm text-ink-muted">Loading floor plan…</p>;
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {floors.map((floor) => (
            <button
              key={floor}
              onClick={() => setActiveFloor(floor)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                floor === activeFloor
                  ? "bg-surface-0 text-white"
                  : "bg-surface-1 text-ink-secondary hover:bg-surface-3"
              }`}
            >
              {floor}
            </button>
          ))}
          <button
            onClick={handleAddFloor}
            className="rounded-full border border-dashed border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink-muted hover:border-hairline-strong hover:text-ink-secondary"
          >
            + Floor
          </button>
        </div>
        <button onClick={handleAddTable} disabled={creating} className="btn-primary text-sm">
          + Table
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs text-ink-muted">
        {(Object.keys(TABLE_STATUS_LABELS) as TableStatus[]).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${TABLE_STATUS_COLORS[status].dot}`} />
            {TABLE_STATUS_LABELS[status]}
          </span>
        ))}
      </div>

      {visibleTables.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No tables on this floor yet. Add one, then drag it into place.
        </p>
      ) : (
        <div
          className="relative h-[560px] w-full touch-none overflow-auto rounded-2xl border border-hairline bg-surface-1"
          style={{ backgroundImage: "radial-gradient(circle, #e5e5e5 1px, transparent 1px)", backgroundSize: "24px 24px" }}
        >
          {visibleTables.map((table) => {
            const colors = TABLE_STATUS_COLORS[table.status];
            const shapeClass =
              table.shape === "circle" ? "rounded-full" : table.shape === "square" ? "rounded-lg" : "rounded-xl";
            return (
              <div
                key={table.id}
                onPointerDown={(e) => handlePointerDown(e, table)}
                onPointerMove={handlePointerMove}
                onPointerUp={(e) => handlePointerUp(e, table)}
                className={`absolute flex cursor-grab select-none flex-col items-center justify-center border-2 p-1 text-center shadow-sm active:cursor-grabbing ${colors.bg} ${colors.text} ${shapeClass}`}
                style={{
                  left: table.posX ?? 20,
                  top: table.posY ?? 20,
                  width: table.width,
                  height: table.height,
                  transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined,
                  borderColor: "currentColor",
                }}
              >
                <span className="text-xs font-semibold">{table.name}</span>
                {table.capacity != null && <span className="text-[10px] opacity-75">Seats {table.capacity}</span>}
                <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide opacity-75">
                  {TABLE_STATUS_LABELS[table.status]}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {selectedTableId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={closeDetail}>
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface-2 p-5 shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {detailLoading || !detail ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : (
              <>
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-ink">{detail.table.name}</h3>
                    <p className="text-xs text-ink-muted">
                      {detail.table.capacity != null ? `Seats ${detail.table.capacity} · ` : ""}
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${TABLE_STATUS_COLORS[detail.table.status].text}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${TABLE_STATUS_COLORS[detail.table.status].dot}`} />
                        {TABLE_STATUS_LABELS[detail.table.status]}
                      </span>
                    </p>
                  </div>
                  <button onClick={closeDetail} className="text-sm text-ink-faint hover:text-ink-secondary">
                    Close
                  </button>
                </div>

                {detail.activeOrders.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                      Active orders
                    </p>
                    <ul className="space-y-1.5">
                      {detail.activeOrders.map((o) => (
                        <li key={o.id} className="rounded-lg bg-surface-1 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span>
                              <span className="font-medium">{o.orderNumber}</span> — {o.status}
                              {o.customerName ? ` · ${o.customerName}` : ""}
                              {o.isOnHold && (
                                <span className="ml-1.5 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                                  On hold
                                </span>
                              )}
                            </span>
                            <span className="flex flex-wrap gap-1">
                              {o.isOnHold ? (
                                <button
                                  onClick={() => resumeOrder(o.id)}
                                  disabled={tableOpBusy}
                                  className="rounded-full border border-hairline-strong px-2 py-0.5 text-[10px] font-medium text-ink-secondary hover:border-hairline-strong"
                                >
                                  Resume
                                </button>
                              ) : (
                                <button
                                  onClick={() => holdOrder(o.id)}
                                  disabled={tableOpBusy}
                                  className="rounded-full border border-hairline-strong px-2 py-0.5 text-[10px] font-medium text-ink-secondary hover:border-hairline-strong"
                                >
                                  Hold
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  setTransferringOrderId((cur) => (cur === o.id ? null : o.id))
                                }
                                disabled={tableOpBusy}
                                className="rounded-full border border-hairline-strong px-2 py-0.5 text-[10px] font-medium text-ink-secondary hover:border-hairline-strong"
                              >
                                Transfer
                              </button>
                            </span>
                          </div>
                          {o.isOnHold && o.holdReason && (
                            <p className="mt-1 text-[10px] text-amber-400">Reason: {o.holdReason}</p>
                          )}
                          {transferringOrderId === o.id && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <select
                                value={transferTargetTableId}
                                onChange={(e) => setTransferTargetTableId(e.target.value)}
                                className="input py-1 text-xs"
                              >
                                <option value="">Move to table…</option>
                                {tables
                                  .filter((t) => t.id !== detail.table.id && t.branchId === detail.table.branchId)
                                  .map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name}
                                    </option>
                                  ))}
                              </select>
                              <button
                                onClick={() => transferOrder(o.id)}
                                disabled={tableOpBusy || !transferTargetTableId}
                                className="btn-primary px-2 py-1 text-[10px]"
                              >
                                Move
                              </button>
                              <button
                                onClick={() => {
                                  setTransferringOrderId(null);
                                  setTransferTargetTableId("");
                                }}
                                disabled={tableOpBusy}
                                className="btn-secondary px-2 py-1 text-[10px]"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mb-4">
                  {merging ? (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-1 px-3 py-2">
                      <select
                        value={mergeSourceTableId}
                        onChange={(e) => setMergeSourceTableId(e.target.value)}
                        className="input py-1 text-xs"
                      >
                        <option value="">Merge orders from…</option>
                        {tables
                          .filter((t) => t.id !== detail.table.id && t.branchId === detail.table.branchId)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                      <button
                        onClick={mergeIntoCurrentTable}
                        disabled={tableOpBusy || !mergeSourceTableId}
                        className="btn-primary px-2 py-1 text-[10px]"
                      >
                        Merge into {detail.table.name}
                      </button>
                      <button
                        onClick={() => {
                          setMerging(false);
                          setMergeSourceTableId("");
                        }}
                        disabled={tableOpBusy}
                        className="btn-secondary px-2 py-1 text-[10px]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setMerging(true)}
                      className="text-xs font-medium text-ink-muted underline decoration-dotted hover:text-ink-secondary"
                    >
                      Merge another table into this one
                    </button>
                  )}
                </div>

                {detail.upcomingReservations.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                      Upcoming reservations today
                    </p>
                    <ul className="space-y-1">
                      {detail.upcomingReservations.map((r) => (
                        <li key={r.id} className="rounded-lg bg-purple-500/15 px-3 py-2 text-xs text-purple-300">
                          {new Date(r.reservationTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} —{" "}
                          {r.customerName} (party of {r.partySize})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mb-4 flex flex-wrap gap-2">
                  {manualNextStatuses(detail.table.status).map((next) => (
                    <button
                      key={next}
                      onClick={() => changeStatus(detail.table.id, next)}
                      className="rounded-full border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-hairline-strong"
                    >
                      Mark {TABLE_STATUS_LABELS[next]}
                    </button>
                  ))}
                </div>

                <button onClick={() => openInPOS(detail.table.id)} className="btn-primary w-full text-sm">
                  Open in POS
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
