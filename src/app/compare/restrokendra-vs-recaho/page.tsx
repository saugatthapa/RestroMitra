import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROKENDRA_PLANS, RECAHO } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "RestroKendra vs. Recaho — Feature Comparison for Nepal Restaurants (2026)",
  description:
    "An honest, sourced comparison of RestroKendra and Recaho restaurant software for restaurants in Nepal: features, transparent pricing, and which one may suit you. Last reviewed September 2026.",
  path: "/compare/restrokendra-vs-recaho",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/restaurant-pos-nepal" },
  { name: "RestroKendra vs. Recaho", path: "/compare/restrokendra-vs-recaho" },
];

type Row = { label: string; restrokendra: string; recaho: string };

const ROWS: Row[] = [
  { label: "POS & billing", restrokendra: "Split payments, paisa-accurate", recaho: "POS billing (per their site)" },
  { label: "QR table ordering", restrokendra: "Included on every plan", recaho: "QR menu website (per their site)" },
  { label: "Kitchen display", restrokendra: "Included (KDS)", recaho: "Included (KDS, per their site)" },
  { label: "Inventory & recipe costing", restrokendra: "Included on every plan", recaho: "Included — recipe costing, purchase/vendor management (per their site)" },
  { label: "Reservations", restrokendra: "Booking book with status flow", recaho: "Table reservation & queue management (per their site)" },
  { label: "Loyalty / CRM", restrokendra: "Automatic Bronze–Platinum tiers", recaho: "CRM with loyalty & wallet, WhatsApp/email marketing (per their site)" },
  { label: "AI assistant", restrokendra: "Plain-language Q&A over your own data", recaho: "\"Recaho Mind\" — AI for marketing, operations, menu optimization (per their site)" },
  { label: "Self-ordering kiosks / call center", restrokendra: "Not offered", recaho: "Both listed among their features" },
  { label: "Free website builder", restrokendra: "Included on every plan", recaho: "Online ordering website listed as a feature; \"free\" not stated" },
  { label: "Payroll", restrokendra: "Included, tied to attendance", recaho: "Not listed among their published features" },
  { label: "Pricing transparency", restrokendra: "Published, transparent monthly pricing", recaho: "Not publicly disclosed — request-a-quote only" },
  { label: "Market focus", restrokendra: "Built specifically for Nepal", recaho: "Global platform (\"15,000+ businesses across 18+ countries\") with a Nepal landing page" },
];

export default function CompareRecahoPage() {
  return (
    <MarketingPageShell contentClassName="max-w-5xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Comparison</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        RestroKendra vs. Recaho
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        Recaho is a large, multi-country POS platform with a Nepal-targeted landing page;
        RestroKendra is built specifically for restaurants operating in Nepal. Here&apos;s what each
        publicly offers, sourced directly from Recaho&apos;s own site — not a one-sided sales pitch.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. Recaho figures sourced from{" "}
        {RECAHO.sources.map((s, i) => (
          <span key={s}>
            {i > 0 && ", "}
            <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
              {s.replace(/^https?:\/\//, "")}
            </a>
          </span>
        ))}
        . RestroKendra is not affiliated with Recaho.
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Who each is</h2>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A connected restaurant operating system — POS, QR ordering, kitchen display,
              inventory, staff, payroll, account books, an AI assistant, and a free public
              website — built specifically for restaurants operating in Nepal, with transparent,
              published pricing.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-bold text-neutral-800">Recaho</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A large international restaurant-tech platform. On its own site, Recaho describes
              itself with claims including:{" "}
              {RECAHO.selfClaims.map((c, i) => (
                <span key={c}>
                  {i > 0 && "; "}
                  {c}
                </span>
              ))}
              . These are Recaho&apos;s own statements about itself, not independently verified here.
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
                  <th className="px-5 py-3.5">Recaho</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"}>
                    <td className="px-5 py-3.5 font-medium text-neutral-800">{row.label}</td>
                    <td className="bg-orange-50/60 px-5 py-3.5 text-neutral-700">{row.restrokendra}</td>
                    <td className="px-5 py-3.5 text-neutral-600">{row.recaho}</td>
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
            <h3 className="text-sm font-bold text-neutral-800">Recaho</h3>
            <p className="mt-3 text-sm leading-relaxed text-neutral-700">{RECAHO.pricing.note}</p>
            <p className="mt-3 text-xs text-neutral-500">Contact Recaho directly for a current quote.</p>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Which one may suit you</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          Recaho&apos;s broader toolset — self-ordering kiosks, a call center system, WhatsApp/email
          marketing — may suit a larger, multi-outlet operation used to enterprise sales
          processes. If you want to know your exact monthly cost before you ever talk to a
          salesperson, and you want a system built around Nepal&apos;s market specifically rather
          than localized from a global platform, RestroKendra&apos;s published pricing is a more
          direct starting point.
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
          <Link href="/compare/restrokendra-vs-hamrosan" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40">
            RestroKendra vs. Hamro SAN →
          </Link>
        </div>
      </section>

      <MarketingCta />
    </MarketingPageShell>
  );
}
