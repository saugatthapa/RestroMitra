import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RECAHO } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "Recaho Alternatives for Restaurants in Nepal",
  description:
    "Looking for a Recaho alternative? RestroKendra is a restaurant POS platform built specifically for Nepal, with transparent published pricing instead of a request-a-quote model.",
  path: "/alternatives/recaho",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Alternatives", path: "/restaurant-pos-nepal" },
  { name: "Recaho alternatives", path: "/alternatives/recaho" },
];

export default function RecahoAlternativesPage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Alternatives</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Looking for a Recaho alternative?
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        If you&apos;re evaluating Recaho for your restaurant and want to see what else is out
        there, RestroKendra is a connected restaurant operating system built specifically for
        restaurants operating in Nepal — worth a look alongside it.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroKendra is an independent product and is not
        affiliated with Recaho; figures about Recaho are sourced from{" "}
        {RECAHO.sources.map((s, i) => (
          <span key={s}>
            {i > 0 && ", "}
            <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
              {s.replace(/^https?:\/\//, "")}
            </a>
          </span>
        ))}
        .
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">What Recaho offers</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Recaho is a large, multi-country restaurant-tech platform ({RECAHO.selfClaims[0]}) with
          a Nepal-targeted landing page. Per its own site, it offers: {RECAHO.features.join(", ")}
          . {RECAHO.pricing.note}
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Why restaurants consider RestroKendra instead</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Pricing you can see before you talk to sales</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Rs 799–3,499/month, published on the pricing page — no request-a-quote step required
              just to know the cost.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Built for Nepal specifically</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Not a global platform localized with a landing page — payroll, staff attendance, and
              billing are built around how Nepali restaurants actually operate.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Nepali ⇄ English calendar</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Flip the whole dashboard between AD and Bikram Sambat dates with one tap.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">A simpler, focused system</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              No self-ordering kiosks or call-center add-ons to configure — one connected core
              system for running a restaurant.
            </p>
          </div>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          Recaho&apos;s broader toolset (self-ordering kiosks, a call center system, WhatsApp/email
          marketing) may suit a larger, multi-outlet operation with an enterprise sales process
          already in mind. See the full{" "}
          <Link href="/compare/restrokendra-vs-recaho" className="font-medium text-orange-600 hover:underline">
            feature-by-feature comparison
          </Link>{" "}
          for a fair side-by-side.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Other options</h2>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link href="/compare/restrokendra-vs-recaho" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            Full RestroKendra vs. Recaho comparison →
          </Link>
          <Link href="/alternatives/restrohub" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroHub alternatives →
          </Link>
          <Link href="/alternatives/restrox" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroX alternatives →
          </Link>
          <Link href="/restaurant-pos-nepal" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            Full restaurant POS guide →
          </Link>
        </div>
      </section>

      <MarketingCta />
    </MarketingPageShell>
  );
}
