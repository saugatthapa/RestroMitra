import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { LAST_REVIEWED, RESTROKENDRA_PLANS, RESTROX } from "@/lib/seo/competitors";

export const metadata: Metadata = createMetadata({
  title: "RestroKendra vs. RestroX — Feature & Pricing Comparison (2026)",
  description:
    "An honest, sourced comparison of RestroKendra and RestroX restaurant POS software: features, annual vs. monthly pricing, and which type of restaurant each may suit. Last reviewed September 2026.",
  path: "/compare/restrokendra-vs-restrox",
});

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/restaurant-pos-nepal" },
  { name: "RestroKendra vs. RestroX", path: "/compare/restrokendra-vs-restrox" },
];

type Row = { label: string; restrokendra: string; restrox: string };

const ROWS: Row[] = [
  { label: "POS & billing", restrokendra: "Split payments, paisa-accurate", restrox: "KOT/BOT-based billing (per their site)" },
  { label: "QR table ordering", restrokendra: "Included on every plan", restrox: "Not listed among their published features" },
  { label: "Kitchen display", restrokendra: "Included (KDS)", restrox: "KOT/BOT ticketing (per their site)" },
  { label: "Inventory", restrokendra: "Included on every plan, recipe-linked", restrox: "Premium tier and above (per their site)" },
  { label: "Accounting", restrokendra: "Account books included on every plan", restrox: "Premium tier and above (per their site)" },
  { label: "CRM & loyalty", restrokendra: "Included on every plan", restrox: "Premium tier and above (per their site)" },
  { label: "Multi-outlet / multi-branch", restrokendra: "Growth: up to 3 · Pro: unlimited", restrox: "Platinum tier and above (per their site)" },
  { label: "AI assistant", restrokendra: "Plain-language Q&A over your own data", restrox: "Not listed among their published features" },
  { label: "Free website builder", restrokendra: "Included on every plan", restrox: "Not listed among their published features" },
  { label: "Staff/table limits", restrokendra: "Starter: 5 staff, Growth: 15, Pro: unlimited", restrox: "Tiered by plan — 5 to unlimited logins (per their site)" },
  { label: "Billing cycle", restrokendra: "Monthly, cancel anytime", restrox: "Annual only (per their site, besides the free tier)" },
  { label: "Free tier", restrokendra: "30-day free trial on every plan", restrox: "A permanent free tier with limited features, plus a 14-day trial on paid plans" },
];

export default function CompareRestroXPage() {
  return (
    <MarketingPageShell contentClassName="max-w-5xl">
      <JsonLd data={createBreadcrumbSchema(BREADCRUMB_ITEMS)} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Comparison</span>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
        RestroKendra vs. RestroX
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-neutral-600">
        RestroX prices annually across tiered feature limits; RestroKendra prices monthly with
        the full feature set on every plan. Here&apos;s what each publicly offers, sourced directly
        from RestroX&apos;s own pricing page — not a one-sided sales pitch.
      </p>
      <p className="mt-2 text-xs text-neutral-400">
        Last reviewed: {LAST_REVIEWED}. RestroX figures sourced from{" "}
        {RESTROX.sources.map((s, i) => (
          <span key={s}>
            {i > 0 && ", "}
            <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-neutral-600">
              {s.replace(/^https?:\/\//, "")}
            </a>
          </span>
        ))}
        . RestroKendra is not affiliated with RestroX.
      </p>

      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Who each is</h2>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-5">
            <h3 className="text-sm font-bold text-orange-700">RestroKendra</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A connected restaurant operating system — POS, QR ordering, kitchen display,
              inventory, staff, payroll, account books, an AI assistant, and a free public
              website — with the same feature set on every plan, priced by staff/branch limits.
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
            <h3 className="text-sm font-bold text-neutral-800">RestroX</h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">
              A Nepal-focused restaurant POS platform priced across four tiers, each unlocking
              more features. On its own site, RestroX describes itself with claims including:{" "}
              {RESTROX.selfClaims.map((c, i) => (
                <span key={c}>
                  {i > 0 && "; "}
                  {c}
                </span>
              ))}
              . These are RestroX&apos;s own statements about itself, not independently verified here.
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
                  <th className="px-5 py-3.5">RestroX</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"}>
                    <td className="px-5 py-3.5 font-medium text-neutral-800">{row.label}</td>
                    <td className="bg-orange-50/60 px-5 py-3.5 text-neutral-700">{row.restrokendra}</td>
                    <td className="px-5 py-3.5 text-neutral-600">{row.restrox}</td>
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
          RestroX bills annually (its published plans have no monthly option). To compare fairly
          against RestroKendra&apos;s monthly pricing, the table below shows RestroX&apos;s real annual
          price alongside a monthly-equivalent — that figure is a division, not a plan RestroX
          itself sells.
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
            <h3 className="text-sm font-bold text-neutral-800">RestroX (billed annually)</h3>
            <ul className="mt-3 space-y-2 text-sm text-neutral-700">
              {RESTROX.pricing.plans.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong> — Rs {p.priceRsYearly.toLocaleString("en-IN")}/year
                  {p.priceRsYearly > 0 && (
                    <> (≈ Rs {p.monthlyEquivalentRs.toLocaleString("en-IN")}/month equivalent)</>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-neutral-500">
              Premium and Platinum renew at a 50% discount after year one, per RestroX&apos;s site. A
              14-day free trial is offered on paid plans; the Free plan has no time limit.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Which one may suit you</h2>
        <p className="mt-3 leading-relaxed text-neutral-700">
          If a permanent free tier for a very small, low-volume operation matters most, RestroX&apos;s
          Free plan is worth a look. If you want inventory, accounting, and CRM/loyalty included
          from day one rather than gated behind a higher-priced tier — plus QR ordering and an AI
          assistant, which aren&apos;t listed among RestroX&apos;s published features — RestroKendra
          includes the full feature set on every plan.
        </p>
        <p className="mt-3 leading-relaxed text-neutral-700">
          If committing to a year of billing upfront is a concern, RestroKendra&apos;s monthly
          pricing with no lock-in may suit better than RestroX&apos;s annual-only paid plans.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Looking for more options?</h2>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/compare/restrokendra-vs-restrohub"
            className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
          >
            RestroKendra vs. RestroHub →
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
