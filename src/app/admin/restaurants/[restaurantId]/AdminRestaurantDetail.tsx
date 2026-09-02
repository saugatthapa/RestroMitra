"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api-client";
import { type Plan, type PlanKey } from "@/lib/plans";
import { SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from "@/lib/subscription";
import { EntitlementsPanel } from "./EntitlementsPanel";
import { AiUsagePanel } from "./AiUsagePanel";
import { ImpersonationPanel } from "./ImpersonationPanel";
import { SupportPanel, type SupportPanelData } from "./SupportPanel";
import { BranchesPanel, RecentOrdersPanel, RestaurantAuditLogPanel } from "./RestaurantOperationsPanels";

type Detail = {
  restaurant: {
    id: string;
    slug: string;
    name: string;
    type: string;
    city: string | null;
    district: string | null;
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: string | null;
    planKey: PlanKey | null;
    // This restaurant's own effective plan (price-lock applied) — see
    // getEffectivePlan() in lib/plans-db.ts.
    plan: Plan | null;
    // Phase 7 — AI Provider Control Center. See AiUsagePanel.
    aiMonthlyRequestLimitOverride: number | null;
    aiMonthlyRequestLimit: number | null;
    aiRequestsThisMonth: number;
    isActive: boolean;
    createdAt: string;
  };
  owner: { fullName: string; phone: string; email: string | null } | null;
  staffCount: number;
  events: {
    id: string;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    planKey: string | null;
    note: string | null;
    createdAt: string;
    performedBy: string | null;
  }[];
  // Phase 4 — every plan, including retired ones, for the "Assign plan"
  // dropdown; see getAllPlansForAdmin() in lib/plans-db.ts.
  plans: Plan[];
} & SupportPanelData;

function formatEventType(eventType: string) {
  return eventType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function AdminRestaurantDetail({ restaurantId }: { restaurantId: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [extendDays, setExtendDays] = useState(30);
  // Phase 4 — no more hardcoded "starter" default (plan keys aren't a
  // fixed literal set anymore); seeded from the loaded catalog once it
  // arrives, see the effect below.
  const [assignPlanKey, setAssignPlanKey] = useState<PlanKey>("");
  const [activateOnAssign, setActivateOnAssign] = useState(true);
  const [note, setNote] = useState("");

  const [suspendReason, setSuspendReason] = useState("");
  const [suspendBusy, setSuspendBusy] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiGet<Detail>(`/api/admin/restaurants/${restaurantId}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this restaurant.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  useEffect(() => {
    if (!assignPlanKey && data && data.plans.length > 0) {
      setAssignPlanKey(data.restaurant.planKey ?? data.plans[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function runAction(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiPatch(`/api/admin/restaurants/${restaurantId}/subscription`, body);
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runSuspensionAction(action: "suspend" | "reactivate") {
    if (!suspendReason.trim()) {
      setSuspendError("Enter a reason first.");
      return;
    }
    setSuspendBusy(true);
    setSuspendError(null);
    try {
      await apiPost(`/api/admin/restaurants/${restaurantId}/suspension`, {
        action,
        reason: suspendReason,
      });
      setSuspendReason("");
      await load();
    } catch (err) {
      setSuspendError(err instanceof ApiError ? err.message : "That action failed.");
    } finally {
      setSuspendBusy(false);
    }
  }

  if (error && !data) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-ink-faint">Loading…</p>;

  const { restaurant, owner } = data;

  return (
    <div>
      <Link href="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← All restaurants
      </Link>

      <div className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">{restaurant.name}</h1>
          <p className="text-sm text-ink-muted">
            {restaurant.slug} · {[restaurant.city, restaurant.district].filter(Boolean).join(", ") || "—"}
          </p>
        </div>
        <div className="flex gap-2">
          <span className="rounded-full bg-surface-1 px-3 py-1 text-xs font-medium text-ink-secondary">
            {SUBSCRIPTION_STATUS_LABELS[restaurant.subscriptionStatus]}
          </span>
          {!restaurant.isActive && (
            <span className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-medium text-red-300">
              Suspended
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/15 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <div className="rounded-xl border border-hairline bg-surface-2 p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Overview</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Owner" value={owner ? `${owner.fullName} · ${owner.phone}` : "—"} />
              <Row label="Staff accounts" value={String(data.staffCount)} />
              <Row label="Plan" value={restaurant.plan?.name ?? "None assigned"} />
              <Row
                label="Trial ends"
                value={restaurant.trialEndsAt ? formatDate(restaurant.trialEndsAt) : "—"}
              />
              <Row label="Created" value={formatDate(restaurant.createdAt)} />
            </dl>
          </div>

          <div className="mt-4 rounded-xl border border-hairline bg-surface-2 p-4">
            <h2 className="mb-1 text-sm font-semibold text-ink">Suspension</h2>
            <p className="mb-3 text-xs text-ink-muted">
              Reversible and data-preserving — blocks staff dashboard access and the public
              menu/QR pages without deleting anything. Independent of subscription/billing state.
            </p>
            <textarea
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Reason (required, recorded in the audit log)…"
              rows={2}
              className="input mb-3"
            />
            {suspendError && <p className="mb-3 text-sm text-red-400">{suspendError}</p>}
            {restaurant.isActive ? (
              <button
                disabled={suspendBusy}
                onClick={() => runSuspensionAction("suspend")}
                className="inline-flex items-center justify-center rounded-lg border border-red-500/30 bg-surface-2 px-4 py-2.5 text-sm font-semibold text-red-400 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Suspend restaurant
              </button>
            ) : (
              <button
                disabled={suspendBusy}
                onClick={() => runSuspensionAction("reactivate")}
                className="btn-primary"
              >
                Reactivate restaurant
              </button>
            )}
          </div>

          <ImpersonationPanel restaurantId={restaurantId} restaurantName={restaurant.name} />

          <div className="mt-4 rounded-xl border border-hairline bg-surface-2 p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Actions</h2>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (shown in the timeline)…"
              rows={2}
              className="input mb-3"
            />

            <div className="mb-4 flex items-end gap-2">
              <label className="flex-1 text-xs text-ink-muted">
                Extend trial by (days)
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={extendDays}
                  onChange={(e) => setExtendDays(Number(e.target.value))}
                  className="input mt-1"
                />
              </label>
              <button
                disabled={busy}
                onClick={() => runAction({ action: "extend_trial", days: extendDays, note: note || undefined })}
                className="btn-secondary"
              >
                Extend
              </button>
              <button
                disabled={busy}
                onClick={() => runAction({ action: "shorten_trial", days: extendDays, note: note || undefined })}
                className="btn-secondary"
              >
                Shorten
              </button>
            </div>

            <div className="mb-4 flex items-end gap-2">
              <label className="flex-1 text-xs text-ink-muted">
                {restaurant.subscriptionStatus === "trialing" ? "Convert trial to plan" : "Assign plan"}
                <select
                  value={assignPlanKey}
                  onChange={(e) => setAssignPlanKey(e.target.value as PlanKey)}
                  className="input mt-1"
                >
                  {data.plans.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy || !assignPlanKey}
                onClick={() =>
                  runAction({
                    action: "assign_plan",
                    planKey: assignPlanKey,
                    activate: activateOnAssign,
                    note: note || undefined,
                  })
                }
                className="btn-primary"
              >
                {restaurant.subscriptionStatus === "trialing" && activateOnAssign ? "Convert" : "Assign"}
              </button>
            </div>
            <label className="mb-4 flex items-center gap-2 text-xs text-ink-secondary">
              <input
                type="checkbox"
                checked={activateOnAssign}
                onChange={(e) => setActivateOnAssign(e.target.checked)}
              />
              Activate immediately (marks subscription as active)
            </label>

            <div className="flex flex-wrap gap-2 border-t border-hairline/60 pt-3">
              <button
                disabled={busy}
                onClick={() => runAction({ action: "mark_past_due", note: note || undefined })}
                className="btn-secondary"
              >
                Mark past due
              </button>
              <button
                disabled={busy}
                onClick={() => runAction({ action: "reactivate", note: note || undefined })}
                className="btn-secondary"
              >
                Reactivate
              </button>
              <button
                disabled={busy}
                onClick={() => runAction({ action: "pause", note: note || undefined })}
                className="btn-secondary"
              >
                Pause
              </button>
              <button
                disabled={busy}
                onClick={() => runAction({ action: "cancel", note: note || undefined })}
                className="inline-flex items-center justify-center rounded-lg border border-red-500/30 bg-surface-2 px-4 py-2.5 text-sm font-semibold text-red-400 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel subscription
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-ink">Subscription timeline</h2>
          <div className="divide-y divide-hairline rounded-xl border border-hairline bg-surface-2">
            {data.events.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-ink-faint">No events yet.</p>
            )}
            {data.events.map((event) => (
              <div key={event.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-ink">{formatEventType(event.eventType)}</p>
                  <span className="text-xs text-ink-faint">{formatDate(event.createdAt)}</span>
                </div>
                <p className="text-xs text-ink-muted">
                  {event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus
                    ? `${event.fromStatus} → ${event.toStatus}`
                    : null}
                  {event.planKey ? ` · plan: ${event.planKey}` : ""}
                  {event.performedBy ? ` · by ${event.performedBy}` : " · automatic"}
                </p>
                {event.note && <p className="mt-1 text-xs text-ink-secondary">{event.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <BranchesPanel restaurantId={restaurantId} />
        <RecentOrdersPanel restaurantId={restaurantId} />
        <RestaurantAuditLogPanel restaurantId={restaurantId} />
      </div>

      <div className="mt-6">
        <AiUsagePanel
          restaurantId={restaurantId}
          aiMonthlyRequestLimitOverride={restaurant.aiMonthlyRequestLimitOverride}
          aiMonthlyRequestLimit={restaurant.aiMonthlyRequestLimit}
          aiRequestsThisMonth={restaurant.aiRequestsThisMonth}
          onSaved={load}
        />
      </div>

      <SupportPanel
        restaurantId={restaurantId}
        healthScore={data.healthScore}
        supportTags={data.supportTags}
        supportNotes={data.supportNotes}
        staff={data.staff}
        onChanged={load}
      />

      <EntitlementsPanel restaurantId={restaurantId} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
