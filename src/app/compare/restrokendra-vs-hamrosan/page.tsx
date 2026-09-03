import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROKENDRA_PLANS, HAMROSAN } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "RestroKendra vs. Hamro SAN — Feature & Pricing Comparison (2026)",
  description:
    "An honest, sourced comparison of RestroKendra and Hamro SAN restaurant POS software: features, monthly pricing, and which type of restaurant each may suit. Last reviewed September 2026.",
  path: "/compare/restrokendra-vs-hamrosan",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/restaurant-pos-nepal" },
  { name: "RestroKendra vs. Hamro SAN", path: "/compare/restrokendra-vs-hamrosan" },
];

type Row = { label: string; restrokendra: string; hamrosan: string };

const ROWS: Row[] = [
  { label: "POS & billing", restrokendra: "Split payments, paisa-accurate", hamrosan: "POS with billing (per their site)" },
  { label: "QR table ordering", restrokendra: "Included on every plan", hamrosan: "Digital menu with QR codes (per their site — table-side ordering flow not specified)" },
  { label: "Kitchen display / KOT", restrokendra: "Live kitchen display (KDS)", hamrosan: "Kitchen Order Tickets, KOT-style (per their site)" },
  { label: "Inventory", restrokendra: "Recipe-linked, weighted-average costing", hamrosan: "Barcode-based inventory, expiry & low-stock alerts (per their site)" },
  { label: "Accounting", restrokendra: "Account books included on every plan", hamrosan: "Accounting/finance module, AR/AP (per their site)" },
  { label: "Staff & payroll", restrokendra: "Self-service clock-in/out, payroll tied to attendance", hamrosan: "Not listed among their published features" },
  { label: "Loyalty / CRM", restrokendra: "Automatic Bronze–Platinum tiers", hamrosan: "Not listed among their published features" },
  { label: "AI assistant", restrokendra: "Plain-language Q&A over your own data", hamrosan: "Not listed among their published features" },
  { label: "Free website builder", restrokendra: "Included on every plan", hamrosan: "Not listed among their published features" },
  { label: "Reservations", restrokendra: "Booking book with status flow", hamrosan: "Not listed among their published features" },
  { label: "Free trial", restrokendra: "30 days, no credit card", hamrosan: `${HAMROSAN.pricing.freeTrialDays} days` },
];

export default function CompareHamroSanPage() {
  return (
    <MarketingPageShell contentClassName="max-w-5xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Comparison</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        RestroKendra vs. Hamro SAN
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Both price monthly. Hamro SAN leans toward billing, inventory, and accounting; RestroKendra
        adds QR ordering, staff/payroll, loyalty, and an AI assistant on every plan. Here&apos;s what
        each publicly offers, sourced directly from Hamro SAN&apos;s own site.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. Hamro SAN figures sourced from{" "}
        <a href={HAMROSAN.sources[0]} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
          {HAMROSAN.sources[0].replace(/^https?:\/\//, "")}
        </a>
        . RestroKendra is not affiliated with Hamro SAN.
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Who each is</h2>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A connected restaurant operating system — POS, QR ordering, kitchen display,
              inventory, staff, payroll, account books, an AI assistant, and a free public
              website — the same feature set on every plan.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-bold text-neutral-800">Hamro SAN</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A Nepal-focused POS and billing platform with a strong inventory/accounting focus.
              On its own site, Hamro SAN describes itself with claims including:{" "}
              {HAMROSAN.selfClaims.map((c, i) => (
                <span key={c}>
                  {i > 0 && "; "}
                  {c}
                </span>
              ))}
              . These are Hamro SAN&apos;s own statements about itself, not independently verified here.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Feature by feature</h2>
        <div className="mt-6 overflow-hidden rounded-2xl border border-neutral-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="bg-neutral-50 text-left text-xs font-semibold tracking-wide text-neutral-500 uppercase">
                  <th className="px-5 py-3.5">Capability</th>
                  <th className="bg-orange-50 px-5 py-3.5 text-orange-700">RestroKendra</th>
                  <th className="px-5 py-3.5">Hamro SAN</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"}>
                    <td className="px-5 py-3.5 font-medium text-neutral-800">{row.label}</td>
                    <td className="bg-orange-50/60 px-5 py-3.5 text-neutral-700">{row.restrokendra}</td>
                    <td className="px-5 py-3.5 text-neutral-600">{row.hamrosan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Pricing</h2>
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra</h3>
            <ul className="mt-3 space-y-2 text-sm text-neutral-700">
              {RESTROKENDRA_PLANS.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong> — Rs {p.priceRsMonthly.toLocaleString("en-IN")}/month ({p.staff}, {p.branches})
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-neutral-500">No per-order commission. 30-day free trial, no credit card required.</p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-bold text-neutral-800">Hamro SAN</h3>
            <ul className="mt-3 space-y-2 text-sm text-neutral-700">
              {HAMROSAN.pricing.plans.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong> — Rs {p.priceRsMonthly.toLocaleString("en-IN")}/month ({p.limits})
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-neutral-500">{HAMROSAN.pricing.specialOffer}</p>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Which one may suit you</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          If your priority is tight inventory control with barcode scanning and accounting/AR-AP
          at a low entry price, Hamro SAN&apos;s lower-tier plans are worth a look. If you want QR
          table ordering, staff scheduling tied to payroll, a loyalty program, and an AI
          assistant included without moving to a higher tier, RestroKendra bundles those in from
          the Starter plan.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Looking for more options?</h2>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link href="/compare/restrokendra-vs-restrohub" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. RestroHub →
          </Link>
          <Link href="/compare/restrokendra-vs-restrox" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. RestroX →
          </Link>
          <Link href="/compare/restrokendra-vs-restronp" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. Restronp →
          </Link>
          <Link href="/compare/restrokendra-vs-recaho" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. Recaho →
          </Link>
        </div>
      </section>

      <MarketingCta />
    </MarketingPageShell>
  );
}
