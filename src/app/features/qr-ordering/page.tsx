import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";

export const metadata: Metadata = createMetadata({
  title: "QR Table Ordering for Restaurants",
  description:
    "Let customers scan a table QR code, browse your live menu, and order from their own phone — no app install, no waiting for a free waiter. See how QR ordering works in RestroKendra.",
  path: "/features/qr-ordering",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Features", path: "/restaurant-pos-nepal" },
  { name: "QR table ordering", path: "/features/qr-ordering" },
];

const STEPS = [
  {
    title: "Each table gets its own QR code",
    body: "Generated automatically per table when you set them up — print it once, put it on the table, and it keeps working.",
  },
  {
    title: "Customers scan and see your live menu",
    body: "No app to download. Scanning opens your menu straight in their phone's browser, already scoped to that specific table.",
  },
  {
    title: "Orders land directly in the kitchen and POS",
    body: "A placed order shows up on the kitchen display and in the POS at the same instant — no relaying it by hand from a phone to a ticket.",
  },
];

const BENEFITS = [
  {
    title: "Fewer order mistakes",
    body: "Customers type their own order directly from the menu, so there's no mishearing an order across a noisy dining room.",
  },
  {
    title: "Faster table turns during rushes",
    body: "Tables can order the moment they sit down instead of waiting for a free staff member to come take it.",
  },
  {
    title: "Staff spend less time relaying orders",
    body: "The order goes straight to the kitchen — staff are freed up for service instead of running between tables and the counter.",
  },
  {
    title: "Works on hardware you already own",
    body: "No dedicated tablets to buy per table — it runs in whatever browser is already on a customer's own phone.",
  },
];

export default function QrOrderingFeaturePage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Feature</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        QR table ordering
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Customers scan, browse the live menu, and order straight from their phone — no app
        install, and no waiting for a waiter to become free. The order lands in your kitchen and
        POS the moment it&apos;s placed.
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
          QR ordering isn&apos;t a bolt-on add-in — it shares the same menu, same orders, and same
          real-time data as the{" "}
          <Link href="/features/kds" className="font-medium text-orange-600 hover:underline">
            kitchen display
          </Link>{" "}
          and{" "}
          <Link href="/features/inventory" className="font-medium text-orange-600 hover:underline">
            inventory
          </Link>{" "}
          modules. Read the full{" "}
          <Link href="/restaurant-pos-nepal" className="font-medium text-orange-600 hover:underline">
            restaurant POS guide
          </Link>{" "}
          for how all the pieces fit together.
        </p>
      </section>

      <MarketingCta
        heading="Set up your first table QR code today"
        body="Add your menu and generate table QR codes in minutes — free for 30 days, no credit card required."
      />
    </MarketingPageShell>
  );
}
