import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROKENDRA_PLANS, RESTRONP } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "RestroKendra vs. Restronp — Feature & Pricing Comparison (2026)",
  description:
    "An honest, sourced comparison of RestroKendra and Restronp restaurant POS software: features, annual vs. monthly pricing, and which type of restaurant each may suit. Last reviewed September 2026.",
  path: "/compare/restrokendra-vs-restronp",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/restaurant-pos-nepal" },
  { name: "RestroKendra vs. Restronp", path: "/compare/restrokendra-vs-restronp" },
];

type Row = { label: string; restrokendra: string; restronp: string };

const ROWS: Row[] = [
  { label: "POS & billing", restrokendra: "Split payments, paisa-accurate", restronp: "POS & billing (per their site)" },
  { label: "QR table ordering", restrokendra: "Included on every plan", restronp: "Included (per their site)" },
  { label: "Kitchen display / KOT", restrokendra: "Live kitchen display (KDS)", restronp: "Kitchen Order Ticket system — alerts, priority, auto-print (per their site)" },
  { label: "Inventory", restrokendra: "Included on every plan, recipe-linked deduction", restronp: "Inventory tracking (per their site — recipe-linked deduction not specified)" },
  { label: "Reservations / table booking", restrokendra: "Booking book with status flow", restronp: "Table booking system (per their site)" },
  { label: "Payroll", restrokendra: "Included, tied to attendance", restronp: "Not listed among their published features" },
  { label: "Loyalty / CRM", restrokendra: "Included on every plan", restronp: "Not listed among their published features" },
  { label: "AI assistant", restrokendra: "Plain-language Q&A over your own data", restronp: "Not listed among their published features" },
  { label: "Free website builder", restrokendra: "Included on every plan", restronp: "Not listed among their published features" },
  { label: "Multi-branch", restrokendra: "Growth: up to 3 · Pro: unlimited", restronp: "Supported, single outlet to multi-outlet (per their site)" },
  { label: "Billing cycle", restrokendra: "Monthly, cancel anytime", restronp: "Annual only (per their pricing page)" },
];

export default function CompareRestronpPage() {
  return (
    <MarketingPageShell contentClassName="max-w-5xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Comparison</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        RestroKendra vs. Restronp
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Restronp prices annually across tiered user/table/dish limits; RestroKendra prices
        monthly with the full feature set on every plan. Here&apos;s what each publicly offers,
        sourced directly from Restronp&apos;s own site — not a one-sided sales pitch.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. Restronp figures sourced from{" "}
        {RESTRONP.sources.map((s, i) => (
          <span key={s}>
            {i > 0 && ", "}
            <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
              {s.replace(/^https?:\/\//, "")}
            </a>
          </span>
        ))}
        . RestroKendra is not affiliated with Restronp.
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Who each is</h2>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A connected restaurant operating system — POS, QR ordering, kitchen display,
              inventory, staff, payroll, account books, an AI assistant, and a free public
              website — priced monthly with the full feature set on every plan.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-bold text-neutral-800">Restronp</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A Nepal-focused restaurant POS and billing platform priced across three annual
              tiers. On its own site, Restronp describes itself with claims including:{" "}
              {RESTRONP.selfClaims.map((c, i) => (
                <span key={c}>
                  {i > 0 && "; "}
                  {c}
                </span>
              ))}
              . These are Restronp&apos;s own statements about itself, not independently verified here.
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
                  <th className="px-5 py-3.5">Restronp</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"}>
                    <td className="px-5 py-3.5 font-medium text-neutral-800">{row.label}</td>
                    <td className="bg-orange-50/60 px-5 py-3.5 text-neutral-700">{row.restrokendra}</td>
                    <td className="px-5 py-3.5 text-neutral-600">{row.restronp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Pricing — annual vs. monthly</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">
          Restronp bills annually with no monthly option on its pricing page. The table below
          shows Restronp&apos;s real annual price alongside a monthly-equivalent — a division, not a
          plan Restronp itself sells.
        </p>
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra (billed monthly)</h3>
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
            <h3 className="text-sm font-bold text-neutral-800">Restronp (billed annually)</h3>
            <ul className="mt-3 space-y-2 text-sm text-neutral-700">
              {RESTRONP.pricing.plans.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong> — Rs {p.priceRsYearly.toLocaleString("en-IN")}/year (≈ Rs {p.monthlyEquivalentRs.toLocaleString("en-IN")}/month equivalent)
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-neutral-500">{RESTRONP.pricing.freeTrialNote}</p>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Which one may suit you</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Both cover core POS, KOT, QR ordering, and table booking. If committing to a year of
          billing upfront isn&apos;t a concern and you want dish/table-count tiers to grow into,
          Restronp&apos;s structure is worth evaluating directly. If you want payroll, loyalty, an AI
          assistant, and a free website included from day one — none of which are listed among
          Restronp&apos;s published features — RestroKendra includes the full feature set on every
          monthly plan.
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
          <Link href="/compare/restrokendra-vs-recaho" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. Recaho →
          </Link>
          <Link href="/compare/restrokendra-vs-hamrosan" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. Hamro SAN →
          </Link>
        </div>
      </section>

      <MarketingCta />
    </MarketingPageShell>
  );
}
