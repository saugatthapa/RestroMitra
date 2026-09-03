import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROKENDRA_PLANS, RESTROHUB } from "@/lib/seo/competitors";

/**
 * Honest, sourced comparison page — see competitors.ts for where every
 * RestroHub figure comes from. Deliberately does not claim affiliation
 * with RestroHub, does not attack it, and calls out where RestroHub has
 * something RestroKendra currently doesn't (an AI chatbot with more action
 * tools, a "cheapest" self-claim) rather than presenting a one-sided page.
 */
export const metadata: Metadata = createMetadata({
  title: "RestroKendra vs. RestroHub — Feature & Pricing Comparison (2026)",
  description:
    "An honest, sourced comparison of RestroKendra and RestroHub restaurant POS software: features, pricing, and which type of restaurant each may suit. Last reviewed September 2026.",
  path: "/compare/restrokendra-vs-restrohub",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/restaurant-pos-nepal" },
  { name: "RestroKendra vs. RestroHub", path: "/compare/restrokendra-vs-restrohub" },
];

type Row = { label: string; restrokendra: string; restrohub: string };

const ROWS: Row[] = [
  { label: "POS & billing", restrokendra: "Split payments, paisa-accurate", restrohub: "Split billing (per their site)" },
  { label: "QR table ordering", restrokendra: "Included", restrohub: "Included" },
  { label: "Kitchen display", restrokendra: "Included (KDS)", restrohub: "Included (KDS/BDS)" },
  { label: "Inventory", restrokendra: "Recipe-linked, weighted-average costing", restrohub: "Recipe-based deduction (per their site)" },
  { label: "Staff & attendance", restrokendra: "Self-service clock-in/out, role permissions", restrohub: "Selfie + PIN verified attendance (per their site)" },
  { label: "Payroll", restrokendra: "Included, tied to attendance", restrohub: "Not specified on their public site" },
  { label: "Account books / ledger", restrokendra: "Day/month/year cash book, customer ledger", restrohub: "Customer ledger (per their site)" },
  { label: "Loyalty / CRM", restrokendra: "Automatic Bronze–Platinum tiers", restrohub: "Tiered loyalty program (per their site)" },
  { label: "AI assistant", restrokendra: "Plain-language Q&A over your own data", restrohub: "\"RestroBuddy\" chatbot, ~13 action tools (per their site)" },
  { label: "Table layout / floor plan", restrokendra: "Drag-and-drop table layout included", restrohub: "Floor plan designer (per their site)" },
  { label: "Combos & coupons", restrokendra: "Included", restrohub: "Combo/bundle builder (per their site)" },
  { label: "Website builder", restrokendra: "Free public restaurant website included", restrohub: "Free website builder — 12 blocks, 3 themes, custom domain (per their site)" },
  { label: "Multi-branch", restrokendra: "Growth: up to 3 · Pro: unlimited", restrohub: "Included (per their site)" },
  { label: "Nepali calendar (BS/AD)", restrokendra: "One-tap toggle across the dashboard", restrohub: "Not specified on their public site" },
];

export default function CompareRestroHubPage() {
  return (
    <MarketingPageShell contentClassName="max-w-5xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Comparison</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        RestroKendra vs. RestroHub
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Both are restaurant management platforms built for the Nepali market. This page lays out
        what each publicly offers, feature by feature and price by price, sourced directly from
        each company&apos;s own site — not a one-sided sales pitch.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroHub figures sourced from{" "}
        {RESTROHUB.sources.map((s, i) => (
          <span key={s}>
            {i > 0 && ", "}
            <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
              {s.replace(/^https?:\/\//, "")}
            </a>
          </span>
        ))}
        . RestroKendra is not affiliated with RestroHub.
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Who each is</h2>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A connected restaurant operating system — POS, QR ordering, kitchen display,
              inventory, staff, payroll, account books, an AI assistant, and a free public
              website — built for restaurants operating in Nepal.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-bold text-neutral-800">RestroHub</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A Nepal-focused restaurant management platform. On its own homepage, RestroHub
              describes itself with claims including: {RESTROHUB.selfClaims.map((c, i) => (
                <span key={c}>
                  {i > 0 && "; "}
                  {c}
                </span>
              ))}
              . These are RestroHub&apos;s own statements about itself, not independently verified here.
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
                  <th className="px-5 py-3.5">RestroHub</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"}>
                    <td className="px-5 py-3.5 font-medium text-neutral-800">{row.label}</td>
                    <td className="bg-orange-50/60 px-5 py-3.5 text-neutral-700">{row.restrokendra}</td>
                    <td className="px-5 py-3.5 text-neutral-600">{row.restrohub}</td>
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
            <h3 className="text-sm font-bold text-neutral-800">RestroHub</h3>
            <ul className="mt-3 space-y-2 text-sm text-neutral-700">
              <li><strong>Monthly</strong> — NPR {RESTROHUB.pricing.monthlyRs.toLocaleString("en-IN")}/month</li>
              <li><strong>Annual</strong> — NPR {RESTROHUB.pricing.annualRs.toLocaleString("en-IN")}/year ({RESTROHUB.pricing.annualNote})</li>
              <li><strong>1.5-Year</strong> — NPR {RESTROHUB.pricing.oneAndHalfYearRs.toLocaleString("en-IN")} ({RESTROHUB.pricing.oneAndHalfYearNote})</li>
              <li>A free tier and a custom-quote Enterprise tier are also listed.</li>
            </ul>
            <p className="mt-3 text-xs text-neutral-500">Figures per RestroHub&apos;s own site as of the last-reviewed date above — check their site for current pricing.</p>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Which one may suit you</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Both platforms cover the same core ground — POS, QR ordering, a kitchen display, and
          inventory. If a plain-language AI assistant with a large set of specific action tools,
          or the absolute lowest advertised price, matters most to you, it&apos;s worth evaluating
          RestroHub&apos;s own trial directly. If you want payroll tied to real attendance records,
          a Nepali/English calendar toggle across the whole dashboard, and transparent monthly
          pricing with no annual lock-in, RestroKendra is built around those specifically.
        </p>
        <p className="mt-3 leading-relaxed text-neutral-700">
          The most reliable way to decide is to try both — RestroKendra offers a 30-day free
          trial with no credit card required.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Looking for more options?</h2>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/compare/restrokendra-vs-restrox"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            RestroKendra vs. RestroX →
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
