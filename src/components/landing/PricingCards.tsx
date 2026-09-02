"use client";

import { useState } from "react";
import Link from "next/link";
import { yearlyPriceInPaisa, monthlyEquivalentWhenYearlyInPaisa, type Plan } from "@/lib/plans";

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN")}`;
}

/**
 * Public marketing-page pricing grid, fed the same live `plans` catalog
 * BillingBoard.tsx uses (getActivePlans() — DB-backed, admin-editable at
 * /admin/plans) so a price change there shows up here automatically, with
 * nothing to keep in sync by hand. Deliberately simpler than BillingBoard's
 * version: no "current plan"/"request this plan" state, since a visitor
 * here has no restaurant yet — every card's call to action is the same
 * "Start free trial" straight into /register. The monthly/yearly toggle and
 * the underlying math (yearlyPriceInPaisa/monthlyEquivalentWhenYearlyInPaisa)
 * are the exact same pure helpers BillingBoard already uses, just presented
 * for a prospective signup instead of an existing subscriber.
 */
export function PricingCards({ plans }: { plans: Plan[] }) {
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");

  return (
    <div>
      <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-hairline bg-surface-1 p-1 text-sm font-medium text-ink-muted">
        <button
          type="button"
          onClick={() => setCycle("monthly")}
          className={`rounded-full px-4 py-1.5 transition ${
            cycle === "monthly" ? "bg-surface-2 text-ink shadow-sm" : "hover:text-ink-secondary"
          }`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setCycle("yearly")}
          className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 transition ${
            cycle === "yearly" ? "bg-surface-2 text-ink shadow-sm" : "hover:text-ink-secondary"
          }`}
        >
          Yearly
          <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
            2 months free
          </span>
        </button>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.key}
            className={`relative flex flex-col rounded-2xl border p-6 transition duration-300 ${
              plan.highlight
                ? "border-orange-500/40 bg-orange-500/15 shadow-lg shadow-orange-900/10 sm:-translate-y-2"
                : "border-hairline bg-surface-2 hover:-translate-y-1 hover:border-orange-500/30 hover:shadow-lg hover:shadow-orange-900/5"
            }`}
          >
            {plan.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-600 px-3 py-1 text-[10px] font-bold tracking-wide text-white uppercase shadow-sm">
                Most popular
              </span>
            )}
            <h3 className="text-lg font-bold text-ink">{plan.name}</h3>
            <p className="mt-1 text-sm text-ink-muted">{plan.tagline}</p>

            <p className="mt-5">
              <span className="text-4xl font-extrabold tracking-tight text-ink">
                {formatRupees(cycle === "monthly" ? plan.priceInPaisaMonthly : monthlyEquivalentWhenYearlyInPaisa(plan))}
              </span>
              <span className="text-sm font-medium text-ink-muted">/mo</span>
            </p>
            <p className="mt-1 h-4 text-xs text-ink-faint">
              {cycle === "yearly" ? `${formatRupees(yearlyPriceInPaisa(plan))} billed yearly` : "billed monthly"}
            </p>

            <Link
              href="/register"
              className={plan.highlight ? "btn-primary btn-shine mt-4 w-full" : "btn-secondary mt-4 w-full"}
            >
              Start free trial
            </Link>

            <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-secondary">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <span className="mt-0.5 flex-none text-orange-500">✓</span>
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
