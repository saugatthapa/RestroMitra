import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";

export const metadata: Metadata = createMetadata({
  title: "Restaurant Inventory & Recipe Costing Software",
  description:
    "Recipe-linked stock that deducts itself the moment an order is placed, with weighted-average costing built in. See how RestroKendra keeps inventory accurate automatically.",
  path: "/features/inventory",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Features", path: "/restaurant-pos-nepal" },
  { name: "Inventory & recipes", path: "/features/inventory" },
];

const STEPS = [
  {
    title: "You build a recipe once per menu item",
    body: "List the ingredients and quantities a dish actually uses — this is the link that makes automatic deduction possible.",
  },
  {
    title: "An order is placed",
    body: "Whether from the POS counter or QR ordering, it's the same order data feeding stock.",
  },
  {
    title: "Stock deducts itself automatically",
    body: "No manual stock-count entry after service — the recipe tells the system exactly what left the shelf.",
  },
];

const BENEFITS = [
  {
    title: "Stock counts you can actually trust",
    body: "A spreadsheet nobody updates in real time is decorative. Recipe-linked deduction keeps the number honest without extra data entry.",
  },
  {
    title: "Weighted-average costing built in",
    body: "Know your real cost per dish as ingredient prices change over time, not a stale number set once and forgotten.",
  },
  {
    title: "Catch shrinkage and waste earlier",
    body: "When expected stock and actual stock diverge, that gap is visible instead of getting absorbed into 'we'll recount later.'",
  },
  {
    title: "One source of truth with the kitchen and POS",
    body: "The same order that hits your kitchen display is what deducts inventory — nothing to reconcile between two separate systems.",
  },
];

export default function InventoryFeaturePage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Feature</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Inventory &amp; recipe costing
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Recipe-linked stock that deducts itself the moment an order is placed, with
        weighted-average costing built in — so your inventory numbers reflect what&apos;s actually
        happening on the floor, not a manual count from last week.
      </p>

      <section className="mt-12">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">How it works</h2>
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.title}>
              <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-orange-500 text-sm font-bold text-orange-600">
                {i + 1}
              </div>
              <h3 className="mt-3 text-sm font-semibold text-neutral-900">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Why it matters</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {BENEFITS.map((b) => (
            <div key={b.title} className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
              <h3 className="text-sm font-semibold text-neutral-900">{b.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Comes with the rest of the system</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Inventory deduction is driven by the same order that hits the{" "}
          <Link href="/features/kds" className="font-medium text-orange-600 hover:underline">
            kitchen display
          </Link>{" "}
          and started at{" "}
          <Link href="/features/qr-ordering" className="font-medium text-orange-600 hover:underline">
            QR ordering
          </Link>{" "}
          or the counter. Read the full{" "}
          <Link href="/restaurant-pos-nepal" className="font-medium text-orange-600 hover:underline">
            restaurant POS guide
          </Link>{" "}
          for how all the pieces fit together.
        </p>
      </section>

      <MarketingCta
        heading="Stop reconciling stock by hand"
        body="Link your recipes and let inventory track itself — free for 30 days, no credit card required."
      />
    </MarketingPageShell>
  );
}
