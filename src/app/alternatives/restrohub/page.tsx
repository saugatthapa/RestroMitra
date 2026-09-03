import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROHUB } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "RestroHub Alternatives for Restaurants in Nepal",
  description:
    "Looking for a RestroHub alternative? RestroKendra is a connected restaurant POS, QR ordering, kitchen display, inventory, and payroll platform built for Nepal, with transparent monthly pricing.",
  path: "/alternatives/restrohub",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Alternatives", path: "/restaurant-pos-nepal" },
  { name: "RestroHub alternatives", path: "/alternatives/restrohub" },
];

export default function RestroHubAlternativesPage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Alternatives</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Looking for a RestroHub alternative?
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        If you&apos;re evaluating RestroHub for your restaurant and want to see what else is out
        there, RestroKendra is a connected restaurant operating system built specifically for
        restaurants operating in Nepal — worth a look alongside it.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroKendra is an independent product and is not
        affiliated with RestroHub; figures about RestroHub are sourced from{" "}
        {RESTROHUB.sources.map((s, i) => (
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
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">What RestroHub offers</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Per its own site, RestroHub offers: {RESTROHUB.features.join(", ")}.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Why restaurants consider RestroKendra instead</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Transparent monthly pricing</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Rs 799–3,499/month depending on staff and branch count, cancel anytime, no annual
              lock-in and no per-order commission.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Payroll tied to real attendance</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Self-service clock-in/out and role-based permissions feed directly into payroll —
              one system, not a separate spreadsheet.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Nepali ⇄ English calendar</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Flip the whole dashboard between AD and Bikram Sambat dates with one tap.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">One connected system</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              QR ordering, POS, kitchen display, inventory, staff, loyalty, account books, an AI
              assistant, and reports all share the same live data.
            </p>
          </div>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          RestroHub has its own strengths worth weighing too — notably an AI chatbot with a larger
          published set of action tools, and pricing it markets as the cheapest in the Nepali
          market. See the full{" "}
          <Link href="/compare/restrokendra-vs-restrohub" className="font-medium text-orange-600 hover:underline">
            feature-by-feature comparison
          </Link>{" "}
          for a fair side-by-side.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Other options</h2>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/compare/restrokendra-vs-restrohub"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            Full RestroKendra vs. RestroHub comparison →
          </Link>
          <Link
            href="/alternatives/restrox"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            RestroX alternatives →
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
