"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import {
  RESERVATION_STATUS_LABELS,
  nextStatuses,
  type ReservationStatus,
} from "@/lib/reservation-status";
import { useDateSystem } from "@/lib/date-system";
import { formatBsHint } from "@/lib/nepali-date";
import { localDateIso } from "@/lib/local-date";

type Table = { id: string; name: string };

type Reservation = {
  id: string;
  customerName: string;
  customerPhone: string;
  partySize: number;
  tableId: string | null;
  table: Table | null;
  reservationTime: string;
  durationMinutes: number;
  status: ReservationStatus;
  notes: string | null;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function todayIso() {
  return localDateIso();
}

function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const STATUS_BADGE_CLASS: Record<ReservationStatus, string> = {
  requested: "bg-surface-3 text-ink-secondary",
  confirmed: "bg-blue-500/20 text-blue-300",
  seated: "bg-green-500/20 text-green-300",
  completed: "bg-surface-1 text-ink-muted",
  cancelled: "bg-red-500/20 text-red-400",
  no_show: "bg-red-500/20 text-red-400",
};

export function ReservationsBoard({
  slug,
  canManageReservations,
}: {
  slug: string;
  canManageReservations: boolean;
}) {
  const [date, setDate] = useState(todayIso());
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    setLoading(true);
    try {
      const [resRes, tablesRes] = await Promise.all([
        apiGet<{ reservations: Reservation[] }>(`${base(slug)}/reservations?date=${date}`),
        apiGet<{ tables: Table[] }>(`${base(slug)}/tables`),
      ]);
      setReservations(resRes.reservations);
      setTables(tablesRes.tables);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load reservations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, date]);

  async function changeStatus(id: string, status: ReservationStatus) {
    try {
      await apiPatch(`${base(slug)}/reservations/${id}/status`, { status });
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update status.");
    }
  }

  if (!canManageReservations) {
    return (
      <p className="text-sm text-ink-faint">
        Your role doesn&apos;t have access to reservations.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-hairline bg-surface-2 p-4">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input !w-auto" />
          {dateSystem === "BS" && (
            <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(date)}</span>
          )}
        </label>
        <div className="ml-auto">
          <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
            {showAdd ? "Cancel" : "+ New reservation"}
          </button>
        </div>
      </div>

      {showAdd && (
        <AddReservationForm
          slug={slug}
          tables={tables}
          defaultDate={date}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading reservations…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface-2">
          <table className="w-full text-sm">
            <thead className="bg-surface-1 text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Party</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Table</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {reservations.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-ink-faint">
                    No reservations for this date.
                  </td>
                </tr>
              )}
              {reservations.map((r) =>
                editingId === r.id ? (
                  <EditReservationRow
                    key={r.id}
                    slug={slug}
                    tables={tables}
                    reservation={r}
                    onDone={() => {
                      setEditingId(null);
                      load();
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <ReservationRow
                    key={r.id}
                    reservation={r}
                    onEdit={() => setEditingId(r.id)}
                    onChangeStatus={(status) => changeStatus(r.id, status)}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReservationRow({
  reservation,
  onEdit,
  onChangeStatus,
}: {
  reservation: Reservation;
  onEdit: () => void;
  onChangeStatus: (status: ReservationStatus) => void;
}) {
  const actions = nextStatuses(reservation.status);
  return (
    <tr className="border-t border-hairline/60">
      <td className="px-3 py-2 text-ink-muted">{formatTime(reservation.reservationTime)}</td>
      <td className="px-3 py-2">
        <p className="font-medium text-ink">{reservation.customerName}</p>
        <p className="text-xs text-ink-faint">{reservation.customerPhone}</p>
        {reservation.notes && <p className="text-xs text-ink-faint">{reservation.notes}</p>}
      </td>
      <td className="px-3 py-2">{reservation.partySize}</td>
      <td className="px-3 py-2">{reservation.table?.name ?? "—"}</td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[reservation.status]}`}
        >
          {RESERVATION_STATUS_LABELS[reservation.status]}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex flex-wrap justify-end gap-2">
          {actions.map((next) => (
            <button
              key={next}
              onClick={() => onChangeStatus(next)}
              className="text-xs font-medium text-orange-400 hover:underline"
            >
              {RESERVATION_STATUS_LABELS[next]}
            </button>
          ))}
          <button onClick={onEdit} className="text-xs font-medium text-ink-muted hover:underline">
            Edit
          </button>
        </div>
      </td>
    </tr>
  );
}

function AddReservationForm({
  slug,
  tables,
  defaultDate,
  onAdded,
}: {
  slug: string;
  tables: Table[];
  defaultDate: string;
  onAdded: () => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [tableId, setTableId] = useState("");
  const [time, setTime] = useState(`${defaultDate}T19:00`);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/reservations`, {
        customerName,
        customerPhone,
        partySize: Number(partySize),
        tableId: tableId || undefined,
        reservationTime: new Date(time).toISOString(),
        notes: notes || undefined,
      });
      setCustomerName("");
      setCustomerPhone("");
      setNotes("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create reservation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Name</span>
          <input required value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Phone</span>
          <input
            required
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
            className="input"
            placeholder="98XXXXXXXX"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Party size</span>
          <input
            required
            type="number"
            min={1}
            value={partySize}
            onChange={(e) => setPartySize(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Date &amp; time</span>
          <input
            required
            type="datetime-local"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="input"
          />
          {dateSystem === "BS" && time && (
            <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(time.slice(0, 10))}</span>
          )}
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Table (optional)</span>
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="input">
            <option value="">Not assigned yet</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Booking…" : "Create reservation"}
      </button>
    </form>
  );
}

function EditReservationRow({
  slug,
  tables,
  reservation,
  onDone,
  onCancel,
}: {
  slug: string;
  tables: Table[];
  reservation: Reservation;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [customerName, setCustomerName] = useState(reservation.customerName);
  const [customerPhone, setCustomerPhone] = useState(reservation.customerPhone);
  const [partySize, setPartySize] = useState(String(reservation.partySize));
  const [tableId, setTableId] = useState(reservation.tableId ?? "");
  const [time, setTime] = useState(toDatetimeLocal(reservation.reservationTime));
  const [notes, setNotes] = useState(reservation.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/reservations/${reservation.id}`, {
        customerName,
        customerPhone,
        partySize: Number(partySize),
        tableId: tableId || null,
        reservationTime: new Date(time).toISOString(),
        notes: notes || undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update reservation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-t border-hairline/60 bg-surface-1">
      <td colSpan={6} className="px-3 py-3">
        {error && <p className="mb-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="input" />
          <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} className="input" />
          <input
            type="number"
            min={1}
            value={partySize}
            onChange={(e) => setPartySize(e.target.value)}
            className="input"
          />
          <div>
            <input
              type="datetime-local"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="input"
            />
            {dateSystem === "BS" && time && (
              <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(time.slice(0, 10))}</span>
            )}
          </div>
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="input">
            <option value="">Not assigned</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="input"
          />
        </div>
        <div className="mt-3 flex gap-2">
          <button disabled={saving} onClick={save} className="btn-primary">
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button disabled={saving} onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
