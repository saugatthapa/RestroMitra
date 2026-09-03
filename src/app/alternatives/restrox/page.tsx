import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROX } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "RestroX Alternatives for Restaurants in Nepal",
  description:
    "Looking for a RestroX alternative? RestroKendra is a connected restaurant POS, QR ordering, kitchen display, inventory, and payroll platform with the full feature set on every plan, billed monthly.",
  path: "/alternatives/restrox",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Alternatives", path: "/restaurant-pos-nepal" },
  { name: "RestroX alternatives", path: "/alternatives/restrox" },
];

export default function RestroXAlternativesPage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Alternatives</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Looking for a RestroX alternative?
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        If you&apos;re evaluating RestroX for your restaurant and want to see what else is out
        there, RestroKendra is a connected restaurant operating system built specifically for
        restaurants operating in Nepal — worth a look alongside it.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroKendra is an independent product and is not
        affiliated with RestroX; figures about RestroX are sourced from{" "}
        {RESTROX.sources.map((s, i) => (
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
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">What RestroX offers</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Per its own site, RestroX offers: {RESTROX.features.join(", ")}. Several of these —
          inventory, accounting, CRM/loyalty, and multi-outlet management — are gated to its
          Premium tier and above rather than included on every plan.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Why restaurants consider RestroKendra instead</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">The full feature set on every plan</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Inventory, account books, and loyalty aren&apos;t locked behind a higher tier — every
              RestroKendra plan includes the same core system.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Monthly billing, no annual lock-in</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Rs 799–3,499/month, cancel anytime — no need to commit a year of billing upfront.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">QR table ordering and an AI assistant</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Neither is listed among RestroX&apos;s published features as of the last-reviewed date
              above; both are included in RestroKendra from the start.
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
          RestroX has its own strengths too — notably a permanent free tier for very small,
          low-volume operations. See the full{" "}
          <Link href="/compare/restrokendra-vs-restrox" className="font-medium text-orange-600 hover:underline">
            feature-by-feature comparison
          </Link>{" "}
          for a fair side-by-side, including RestroX&apos;s annual pricing converted to a
          monthly-equivalent.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Other options</h2>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/compare/restrokendra-vs-restrox"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            Full RestroKendra vs. RestroX comparison →
          </Link>
          <Link
            href="/alternatives/restrohub"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            RestroHub alternatives →
          </Link>
          <Link
            href="/restaurant-pos-nepal"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            Full restaurant POS guide →
          </Link>
        </div>
      </section>

      <MarketingCta />
    </MarketingPageShell>
  );
}
