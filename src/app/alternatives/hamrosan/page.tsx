import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, HAMROSAN } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "Hamro SAN Alternatives for Restaurants in Nepal",
  description:
    "Looking for a Hamro SAN alternative? RestroKendra is a connected restaurant POS platform with QR ordering, payroll, loyalty, and an AI assistant included on every plan.",
  path: "/alternatives/hamrosan",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Alternatives", path: "/restaurant-pos-nepal" },
  { name: "Hamro SAN alternatives", path: "/alternatives/hamrosan" },
];

export default function HamroSanAlternativesPage() {
  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Alternatives</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        Looking for a Hamro SAN alternative?
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        If you&apos;re evaluating Hamro SAN for your restaurant and want to see what else is out
        there, RestroKendra is a connected restaurant operating system built specifically for
        restaurants operating in Nepal — worth a look alongside it.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroKendra is an independent product and is not
        affiliated with Hamro SAN; figures about Hamro SAN are sourced from{" "}
        <a href={HAMROSAN.sources[0]} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
          {HAMROSAN.sources[0].replace(/^https?:\/\//, "")}
        </a>
        .
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">What Hamro SAN offers</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Per its own site, Hamro SAN offers: {HAMROSAN.features.join(", ")}. Staff/payroll
          management, a loyalty program, reservations, a website builder, and AI features are not
          listed among its published features.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Why restaurants consider RestroKendra instead</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">QR table ordering included</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Not listed among Hamro SAN&apos;s published features as of the last-reviewed date
              above; included on every RestroKendra plan.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">Staff, payroll, and loyalty built in</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Self-service clock-in/out feeding real payroll, plus an automatic Bronze–Platinum
              loyalty program — from the Starter plan.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">An AI assistant over your own data</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Ask plain-language questions about your restaurant&apos;s own sales and get an
              answer — not listed among Hamro SAN&apos;s features.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-semibold text-neutral-900">A free public website included</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
              Every RestroKendra plan includes a public restaurant website — menu, gallery,
              contact info, and a QR code.
            </p>
          </div>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          Hamro SAN&apos;s barcode-based inventory and accounts receivable/payable tooling may suit
          a restaurant whose priority is tight stock and ledger control at a low entry price. See
          the full{" "}
          <Link href="/compare/restrokendra-vs-hamrosan" className="font-medium text-orange-600 hover:underline">
            feature-by-feature comparison
          </Link>{" "}
          for a fair side-by-side.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Other options</h2>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link href="/compare/restrokendra-vs-hamrosan" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            Full RestroKendra vs. Hamro SAN comparison →
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
