import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";

export const metadata: Metadata = createMetadata({
  title: "Kitchen Display System (KDS) for Restaurants",
  description:
    "Tickets route to the right kitchen station automatically and update live — no shouted orders, no lost paper slips. See how RestroKendra's kitchen display system works.",
  path: "/features/kds",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Features", path: "/restaurant-pos-nepal" },
  { name: "Kitchen display (KDS)", path: "/features/kds" },
];

const STEPS = [
  {
    title: "An order is placed",
    body: "From the POS counter or a customer's QR-ordering session — either way, it's the same order data, not a re-entry.",
  },
  {
    title: "It appears on the kitchen screen instantly",
    body: "No printing, no walking a ticket over — the item list shows up on the kitchen display the moment it's placed.",
  },
  {
    title: "Kitchen staff update status as they cook",
    body: "Marking an item started, ready, or served keeps front-of-house and kitchen looking at the same live state.",
  },
];

const BENEFITS = [
  {
    title: "No shouted orders across a loud kitchen",
    body: "The ticket is on a screen, not relayed verbally — nothing gets lost or misheard during a rush.",
  },
  {
    title: "Nothing gets lost or missed",
    body: "A paper slip can fall off a rail or get buried under others. A live digital queue can't.",
  },
  {
    title: "Clear view of what's actually pending",
    body: "Staff can see exactly what's outstanding at a glance instead of guessing from a stack of tickets.",
  },
  {
    title: "Connected to the same order, start to finish",
    body: "The same order that hits the kitchen display also drives POS billing and inventory deduction — nothing needs re-entering twice.",
  },
];

export default function KdsFeaturePage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Feature</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Kitchen display (KDS)
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Tickets route to the right station automatically and update live — no shouted orders,
        no lost slips. Every order placed at the counter or through QR ordering shows up on the
        kitchen screen the instant it&apos;s placed.
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
          The kitchen display shares the same order data as{" "}
          <Link href="/features/qr-ordering" className="font-medium text-orange-600 hover:underline">
            QR table ordering
          </Link>{" "}
          and drives{" "}
          <Link href="/features/inventory" className="font-medium text-orange-600 hover:underline">
            inventory
          </Link>{" "}
          deduction automatically. Read the full{" "}
          <Link href="/restaurant-pos-nepal" className="font-medium text-orange-600 hover:underline">
            restaurant POS guide
          </Link>{" "}
          for how all the pieces fit together.
        </p>
      </section>

      <MarketingCta
        heading="Give your kitchen a live order queue"
        body="Set up your kitchen stations in minutes — free for 30 days, no credit card required."
      />
    </MarketingPageShell>
  );
}
