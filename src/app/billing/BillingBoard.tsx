"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import {
  yearlyPriceInPaisa,
  monthlyEquivalentWhenYearlyInPaisa,
  type Plan,
  type PlanKey,
} from "@/lib/plans";
import { SUBSCRIPTION_STATUS_LABELS, daysRemaining, type SubscriptionStatus } from "@/lib/subscription";

type BillingInfo = {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  planKey: PlanKey | null;
  // The plan this restaurant is ACTUALLY being charged — same features as
  // the matching `plans` entry, but its priceInPaisaMonthly may be locked
  // to an older rate (see getEffectivePlan() in lib/plans-db.ts). Only
  // trust this for "what am I currently paying" — for "what would a
  // new/switched plan cost," the live `plans` catalog below is the correct
  // source.
  plan: Plan | null;
  // Phase 4 — the plan catalog is DB-backed now; a client component can't
  // hit the DB itself, so the billing API hands over the active catalog
  // (see /api/restaurants/[slug]/billing) instead of this importing a
  // static PLANS array.
  plans: Plan[];
  access: { allowed: boolean; reason: string };
  canManageSubscription: boolean;
  events: {
    id: string;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    planKey: string | null;
    note: string | null;
    createdAt: string;
  }[];
};

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN")}`;
}

function formatEventType(eventType: string) {
  return eventType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function statusTone(status: SubscriptionStatus): { bg: string; text: string } {
  switch (status) {
    case "active":
      return { bg: "bg-emerald-500/15", text: "text-emerald-400" };
    case "trialing":
      return { bg: "bg-orange-500/15", text: "text-orange-400" };
    case "past_due":
      return { bg: "bg-amber-500/15", text: "text-amber-400" };
    default:
      return { bg: "bg-red-500/15", text: "text-red-400" };
  }
}

export function BillingBoard({ slug }: { slug: string }) {
  const [data, setData] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestingPlan, setRequestingPlan] = useState<PlanKey | null>(null);
  const [requestedPlans, setRequestedPlans] = useState<Set<PlanKey>>(new Set());
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("yearly");

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<BillingInfo>(`/api/restaurants/${slug}/billing`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load billing status.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function requestPlan(planKey: PlanKey) {
    setRequestingPlan(planKey);
    try {
      // The upgrade-request flow is a manual sales-assist step (see the
      // route's own comment: no gateway subscription checkout yet, a
      // platform admin follows up to actually activate it) — its schema
      // has no dedicated billing-cycle field, so the toggle's choice rides
      // along in `note` rather than being silently dropped on the floor.
      await apiPost(`/api/restaurants/${slug}/billing/upgrade-request`, {
        planKey,
        note: billingCycle === "yearly" ? "Requested yearly billing (2 months free)." : undefined,
      });
      setRequestedPlans((prev) => new Set(prev).add(planKey));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the request.");
    } finally {
      setRequestingPlan(null);
    }
  }

  if (loading && !data) {
    return <p className="text-sm text-ink-faint">Loading billing status…</p>;
  }
  if (error && !data) {
    return <p className="text-sm text-red-400">{error}</p>;
  }
  if (!data) return null;

  const days = daysRemaining(data.trialEndsAt ? new Date(data.trialEndsAt) : null);
  const tone = statusTone(data.subscriptionStatus);
  const blocked = !data.access.allowed;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Billing</h1>
        <p className="text-sm text-ink-muted">Your plan and subscription status.</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/15 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className={`mb-8 rounded-xl border border-hairline p-5 ${tone.bg}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className={`text-sm font-semibold ${tone.text}`}>
              {SUBSCRIPTION_STATUS_LABELS[data.subscriptionStatus]}
            </span>
            {data.subscriptionStatus === "trialing" && days !== null && (
              <p className="mt-1 text-sm text-ink-secondary">
                {days > 0
                  ? `${days} day${days === 1 ? "" : "s"} left in your free trial.`
                  : "Your free trial has ended."}
              </p>
            )}
            {data.subscriptionStatus === "active" && data.planKey && (
              <p className="mt-1 text-sm text-ink-secondary">
                You&apos;re on the {data.plan?.name ?? data.plans.find((p) => p.key === data.planKey)?.name} plan
                {data.plan && ` at ${formatRupees(data.plan.priceInPaisaMonthly)}/mo`}.
              </p>
            )}
            {data.subscriptionStatus === "past_due" && (
              <p className="mt-1 text-sm text-ink-secondary">
                There&apos;s an issue with your last payment — you still have full access while
                this is resolved.
              </p>
            )}
            {data.subscriptionStatus === "cancelled" && (
              <p className="mt-1 text-sm text-ink-secondary">Your subscription was cancelled.</p>
            )}
            {data.subscriptionStatus === "paused" && (
              <p className="mt-1 text-sm text-ink-secondary">
                Your subscription was paused by RestroKendra. Contact support to resume it.
              </p>
            )}
          </div>
        </div>
        {blocked && (
          <p className="mt-3 border-t border-hairline pt-3 text-sm font-medium text-ink">
            {/* Renamed from "is paused" — now that "paused" is also a real,
                distinct subscription status (see subscription.ts), reusing
                the word here as generic filler for ANY blocked reason
                (expired, cancelled, ...) would read as though that specific
                status applied even when it doesn't. */}
            Access to your dashboard is currently blocked.{" "}
            {data.subscriptionStatus === "paused"
              ? "Contact RestroKendra support to resume."
              : data.canManageSubscription
                ? "Choose a plan below to keep going."
                : "Ask your restaurant owner to choose a plan below."}
          </p>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Plans</h2>
        <div className="inline-flex rounded-full border border-hairline bg-surface-1 p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => setBillingCycle("monthly")}
            className={`rounded-full px-3 py-1.5 transition ${
              billingCycle === "monthly" ? "bg-surface-2 text-ink shadow-sm" : "text-ink-muted"
            }`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingCycle("yearly")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition ${
              billingCycle === "yearly" ? "bg-surface-2 text-ink shadow-sm" : "text-ink-muted"
            }`}
          >
            Yearly
            <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
              2 months free
            </span>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {data.plans.map((plan) => {
          const isCurrent = data.planKey === plan.key && data.subscriptionStatus === "active";
          const alreadyRequested = requestedPlans.has(plan.key);
          // Current plan: show what this restaurant is ACTUALLY paying
          // (may be locked to an older rate). Every other card is a
          // potential switch, so it always shows today's live catalog
          // price — never a lock that wouldn't apply to it.
          const displayPlan = isCurrent && data.plan ? data.plan : plan;
          return (
            <div
              key={plan.key}
              className={`flex flex-col rounded-2xl border p-5 ${
                plan.highlight ? "border-orange-500/40 shadow-sm" : "border-hairline"
              }`}
            >
              {plan.highlight && (
                <span className="mb-2 inline-block w-fit rounded-full bg-orange-500/20 px-2 py-0.5 text-[10px] font-semibold text-orange-400">
                  Most popular
                </span>
              )}
              <h3 className="text-base font-semibold text-ink">{plan.name}</h3>
              {billingCycle === "monthly" ? (
                <p className="mt-1 text-2xl font-bold text-ink">
                  {formatRupees(displayPlan.priceInPaisaMonthly)}
                  <span className="text-sm font-normal text-ink-muted">/mo</span>
                </p>
              ) : (
                <>
                  <p className="mt-1 text-2xl font-bold text-ink">
                    {formatRupees(monthlyEquivalentWhenYearlyInPaisa(displayPlan))}
                    <span className="text-sm font-normal text-ink-muted">/mo</span>
                  </p>
                  <p className="text-xs text-ink-muted">
                    {formatRupees(yearlyPriceInPaisa(displayPlan))} billed yearly
                  </p>
                </>
              )}
              {isCurrent && data.plan && data.plan.priceInPaisaMonthly !== plan.priceInPaisaMonthly && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  Locked-in rate — new subscribers pay {formatRupees(plan.priceInPaisaMonthly)}/mo.
                </p>
              )}
              <p className="mt-2 text-xs text-ink-muted">{plan.tagline}</p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink-secondary">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-orange-500">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                {isCurrent ? (
                  <span className="btn-secondary w-full cursor-default">Current plan</span>
                ) : !data.canManageSubscription ? (
                  <span className="block text-center text-xs text-ink-faint">
                    Only the owner can change plans
                  </span>
                ) : (
                  <button
                    onClick={() => requestPlan(plan.key)}
                    disabled={requestingPlan === plan.key || alreadyRequested}
                    className="btn-primary w-full"
                  >
                    {alreadyRequested
                      ? "Requested"
                      : requestingPlan === plan.key
                        ? "Requesting…"
                        : "Request this plan"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        Requesting a plan lets us know what you want — we&apos;ll follow up to activate it.
        Self-serve checkout is coming soon.
      </p>

      {data.events.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-4 text-sm font-semibold text-ink">Recent activity</h2>
          <div className="divide-y divide-hairline rounded-xl border border-hairline bg-surface-2">
            {data.events.map((event) => (
              <div key={event.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{formatEventType(event.eventType)}</p>
                  {event.note && <p className="text-xs text-ink-muted">{event.note}</p>}
                </div>
                <span className="text-xs text-ink-faint">
                  {new Date(event.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
