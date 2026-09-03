import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTRONP } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "Restronp Alternatives for Restaurants in Nepal",
  description:
    "Looking for a Restronp alternative? RestroKendra is a connected restaurant POS, QR ordering, kitchen display, payroll, and AI platform with transparent monthly pricing.",
  path: "/alternatives/restronp",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Alternatives", path: "/restaurant-pos-nepal" },
  { name: "Restronp alternatives", path: "/alternatives/restronp" },
];

export default function RestronpAlternativesPage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Alternatives</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Looking for a Restronp alternative?
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        If you&apos;re evaluating Restronp for your restaurant and want to see what else is out
        there, RestroKendra is a connected restaurant operating system built specifically for
        restaurants operating in Nepal — worth a look alongside it.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroKendra is an independent product and is not
        affiliated with Restronp; figures about Restronp are sourced from{" "}
        {RESTRONP.sources.map((s, i) => (
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
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">What Restronp offers</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Per its own site, Restronp offers: {RESTRONP.features.join(", ")}. Their pricing is
          annual-only, across three tiers based on user, table, and dish limits.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Why restaurants consider RestroKendra instead</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Monthly billing, no annual lock-in</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Rs 799–3,499/month, cancel anytime — no need to commit a year of billing upfront.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Payroll, loyalty, and an AI assistant included</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              None of these are listed among Restronp&apos;s published features as of the
              last-reviewed date above; all three are included in RestroKendra from the start.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">A free public website included</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Every RestroKendra plan includes a public restaurant website — menu, gallery,
              contact info, and a QR code.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">One connected system</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              QR ordering, POS, kitchen display, inventory, staff, loyalty, account books, and
              reports all share the same live data.
            </p>
          </div>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          Restronp&apos;s tiered structure by table/dish count may suit a restaurant that wants to
          grow into a higher tier over time. See the full{" "}
          <Link href="/compare/restrokendra-vs-restronp" className="font-medium text-orange-600 hover:underline">
            feature-by-feature comparison
          </Link>{" "}
          for a fair side-by-side, including Restronp&apos;s annual pricing converted to a
          monthly-equivalent.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Other options</h2>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link href="/compare/restrokendra-vs-restronp" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            Full RestroKendra vs. Restronp comparison →
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
