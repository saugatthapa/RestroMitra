"use client";

import { useState } from "react";
import Link from "next/link";
import {
  yearlyPriceInPaisa,
  monthlyEquivalentWhenYearlyInPaisa,
  TRIAL_MAX_STAFF,
  TRIAL_MAX_BRANCHES,
  type Plan,
} from "@/lib/plans";

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN")}`;
}

/**
 * The trial is a fixed product decision (every signup gets 30 days, full
 * access, no plan chosen up front — see onboarding.ts), not a row in the
 * `plans` DB table, so it's a hardcoded card rather than DB-driven like
 * Growth/Pro below. Rendered first, ahead of the live catalog. Feature
 * bullets are deliberately honest about what the trial actually grants
 * (see TRIAL_MAX_STAFF/TRIAL_MAX_BRANCHES in lib/plans.ts) rather than
 * implying it unlocks every paid-plan feature.
 */
const FREE_TRIAL_FEATURES = [
  "Full POS, orders & kitchen display",
  "QR table ordering & website builder",
  `Up to ${TRIAL_MAX_STAFF} staff, ${TRIAL_MAX_BRANCHES} branches`,
  "No credit card required",
];

/**
 * Public marketing-page pricing grid. The first card (Free Trial) is
 * hardcoded — see FREE_TRIAL_FEATURES above. The rest come from the same
 * live `plans` catalog BillingBoard.tsx uses (getActivePlans() — DB-backed,
 * admin-editable at /admin/plans) so a price change there shows up here
 * automatically, with nothing to keep in sync by hand. Deliberately simpler
 * than BillingBoard's version: no "current plan"/"request this plan" state,
 * since a visitor here has no restaurant yet — every card's call to action
 * is the same "Start free trial" straight into /register (upgrading past
 * day 30 happens later, from /billing, by messaging us — there's no
 * self-serve checkout to link to here). The monthly/yearly toggle and the
 * underlying math (yearlyPriceInPaisa/monthlyEquivalentWhenYearlyInPaisa)
 * are the exact same pure helpers BillingBoard already uses, just presented
 * for a prospective signup instead of an existing subscriber.
 */
export function PricingCards({ plans }: { plans: Plan[] }) {
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");

  return (
    <div>
      <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-neutral-200 bg-neutral-100 p-1 text-sm font-medium text-neutral-500">
        <button
          type="button"
          onClick={() => setCycle("monthly")}
          className={`rounded-full px-4 py-1.5 transition ${
            cycle === "monthly" ? "bg-white text-neutral-900 shadow-sm" : "hover:text-neutral-700"
          }`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setCycle("yearly")}
          className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 transition ${
            cycle === "yearly" ? "bg-white text-neutral-900 shadow-sm" : "hover:text-neutral-700"
          }`}
        >
          Yearly
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            2 months free
          </span>
        </button>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <div className="relative flex flex-col rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-orange-200 hover:shadow-lg hover:shadow-orange-900/5">
          <h3 className="text-lg font-bold text-neutral-900">Free Trial</h3>
          <p className="mt-1 text-sm text-neutral-500">Try everything, no commitment.</p>

          <p className="mt-5">
            <span className="text-4xl font-extrabold tracking-tight text-neutral-900">Free</span>
          </p>
          <p className="mt-1 h-4 text-xs text-neutral-400">for your first 30 days</p>

          <Link href="/register" className="btn-primary btn-shine mt-4 w-full">
            Start free trial
          </Link>

          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-neutral-600">
            {FREE_TRIAL_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2">
                <span className="mt-0.5 flex-none text-orange-500">✓</span>
                {feature}
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-neutral-100 pt-4 text-xs text-neutral-400">
            After 30 days, upgrade to Growth or Pro to keep going.
          </p>
        </div>
        {plans.map((plan) => (
          <div
            key={plan.key}
            className={`relative flex flex-col rounded-2xl border p-6 transition duration-300 ${
              plan.highlight
                ? "border-orange-300 bg-orange-50/40 shadow-lg shadow-orange-900/10 sm:-translate-y-2"
                : "border-neutral-200 bg-white hover:-translate-y-1 hover:border-orange-200 hover:shadow-lg hover:shadow-orange-900/5"
            }`}
          >
            {plan.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-600 px-3 py-1 text-[10px] font-bold tracking-wide text-white uppercase shadow-sm">
                Most popular
              </span>
            )}
            <h3 className="text-lg font-bold text-neutral-900">{plan.name}</h3>
            <p className="mt-1 text-sm text-neutral-500">{plan.tagline}</p>

            <p className="mt-5">
              <span className="text-4xl font-extrabold tracking-tight text-neutral-900">
                {formatRupees(cycle === "monthly" ? plan.priceInPaisaMonthly : monthlyEquivalentWhenYearlyInPaisa(plan))}
              </span>
              <span className="text-sm font-medium text-neutral-500">/mo</span>
            </p>
            <p className="mt-1 h-4 text-xs text-neutral-400">
              {cycle === "yearly" ? `${formatRupees(yearlyPriceInPaisa(plan))} billed yearly` : "billed monthly"}
            </p>

            <Link
              href="/register"
              className={plan.highlight ? "btn-primary btn-shine mt-4 w-full" : "btn-secondary mt-4 w-full"}
            >
              Start free trial
            </Link>

            <ul className="mt-6 flex-1 space-y-2.5 text-sm text-neutral-600">
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
