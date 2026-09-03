import type { Metadata } from "next";
import Link from "next/link";
import { createMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/lib/seo/JsonLd";
import { createBreadcrumbSchema, createFaqSchema } from "@/lib/seo/json-ld";
import { MarketingPageShell, Breadcrumbs, MarketingCta } from "@/components/marketing/MarketingPageShell";
import { getActivePlans } from "@/lib/plans-db";
import { PricingCards } from "@/components/landing/PricingCards";

/**
 * SEO pillar page for the core keyword cluster around "restaurant POS
 * Nepal" — see SEO_KEYWORD_MAP.md. Written as a genuine buyer's guide (what
 * a restaurant POS actually does, what to check before buying, how
 * RestroKendra fits) rather than a keyword-stuffed wrapper around the
 * homepage; internally links to the feature pages and /compare pages built
 * in the same pass so a reader can go deeper on whichever part matters to
 * them.
 */
export const metadata: Metadata = createMetadata({
  title: "Restaurant POS Software in Nepal — What to Look For & How It Works",
  description:
    "A plain-language guide to restaurant POS software in Nepal: what it does, what to check before buying, and how QR ordering, KDS, inventory, and payroll fit together in one system.",
  path: "/restaurant-pos-nepal",
});

export const revalidate = 3600;

const BREADCRUMB_ITEMS = [
  { name: "Home", path: "/" },
  { name: "Restaurant POS Nepal", path: "/restaurant-pos-nepal" },
];

const CHECKLIST = [
  {
    title: "Does billing round correctly to the paisa?",
    body: "Nepal's VAT and service-charge math needs to be exact, every time, across split payments and partial refunds — not approximated and rounded at the end.",
  },
  {
    title: "Does the kitchen see orders the moment they're placed?",
    body: "A system where the counter and the kitchen work off two different lists (a paper ticket vs. a POS screen) is where most order mistakes and delays actually come from.",
  },
  {
    title: "Does stock update itself when an order is placed?",
    body: "If inventory is a separate spreadsheet nobody updates in real time, it's decorative, not operational. Recipe-linked deduction is what makes stock counts trustworthy.",
  },
  {
    title: "Can it run offline-friendly hardware you already own?",
    body: "A system that requires buying a specific POS terminal is a bigger commitment than one that runs in a browser on a phone, tablet, or the counter PC you already have.",
  },
  {
    title: "Does staff access match who's actually allowed to do what?",
    body: "A cashier and an owner shouldn't see the same screen. Role-based permissions matter once you have more than one person on shift.",
  },
  {
    title: "Is pricing transparent, with no per-order commission?",
    body: "Some platforms charge a cut of every order on top of a subscription. Know which model you're signing up for before you commit.",
  },
];

const PILLARS = [
  {
    title: "Point of sale & billing",
    href: "/#features",
    body: "Fast order entry with split payments across cash, card, and mobile wallets, calculated server-side down to the paisa so totals never drift.",
  },
  {
    title: "QR table ordering",
    href: "/features/qr-ordering",
    body: "Customers scan a table QR code, browse the live menu, and order from their own phone — no app install and no waiting for a free waiter.",
  },
  {
    title: "Kitchen display (KDS)",
    href: "/features/kds",
    body: "Orders route straight to the right kitchen station and update live, replacing shouted orders and paper slips that go missing.",
  },
  {
    title: "Inventory & recipe costing",
    href: "/features/inventory",
    body: "Stock deducts itself the moment an order is placed, using each recipe's actual ingredients, with weighted-average costing built in.",
  },
  {
    title: "Staff, payroll & attendance",
    href: "/#features",
    body: "Self-service clock-in/out, role-based permissions, and payroll that's tied to real attendance records rather than a manual register.",
  },
  {
    title: "Reports & an AI assistant",
    href: "/#features",
    body: "Revenue, top-selling items, and peak hours at a glance, plus a plain-language assistant you can ask about your own restaurant's data.",
  },
];

const FAQ_ITEMS = [
  {
    question: "What does restaurant POS software actually include?",
    answer:
      "At minimum: order entry and billing. A modern system built for Nepal also connects that billing to a live kitchen display, inventory that deducts itself, staff accounts with permissions, and reporting — so the same order updates every part of the restaurant automatically instead of needing to be re-entered.",
  },
  {
    question: "Do I need to buy special hardware?",
    answer:
      "Not with RestroKendra — it runs in a browser on whatever counter PC, tablet, or phone you already have. Some competing systems do require a specific terminal; check this before committing to one.",
  },
  {
    question: "How much does restaurant POS software cost in Nepal?",
    answer:
      "It varies by provider and plan size. RestroKendra's own plans start at Rs 799/month for a single counter and go up to Rs 3,499/month for unlimited staff and branches — see the pricing section below. Every new restaurant gets a full 30-day free trial with no credit card required.",
  },
  {
    question: "Can one system handle QR ordering, a kitchen display, and inventory together?",
    answer:
      "Yes — that's the actual advantage of a connected platform over stitching together separate apps. When QR ordering, POS, KDS, and inventory share the same order data, a placed order updates the kitchen display and deducts stock in the same instant, with nothing to keep in sync by hand.",
  },
];

export default async function RestaurantPosNepalPage() {
  const plans = await getActivePlans();

  return (
    <MarketingPageShell contentClassName="max-w-4xl">
      <JsonLd data={[createBreadcrumbSchema(BREADCRUMB_ITEMS), createFaqSchema(FAQ_ITEMS)]} />
      <Breadcrumbs items={BREADCRUMB_ITEMS} />

      <article>
        <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Buyer&apos;s guide</span>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
          Restaurant POS software in Nepal: what it does, and what to check before buying
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-neutral-600">
          &quot;POS software&quot; means different things depending on who&apos;s selling it. For a Nepali
          restaurant deciding between paper tickets, a spreadsheet, and a real system, this is a
          plain description of what a modern restaurant POS actually does, the questions worth
          asking before you commit to one, and how RestroKendra — built specifically for
          restaurants operating in Nepal — puts those pieces together.
        </p>

        <section className="mt-12">
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">
            What a restaurant POS system actually covers
          </h2>
          <p className="mt-3 leading-relaxed text-neutral-700">
            The name suggests it&apos;s just a billing screen, but in a well-built system &quot;point of
            sale&quot; is the hub every other part of the restaurant connects to. Here&apos;s what that
            looks like broken into its real pieces:
          </p>
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {PILLARS.map((pillar) => (
              <Link
                key={pillar.title}
                href={pillar.href}
                className="group rounded-2xl border border-neutral-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-md"
              >
                <h3 className="text-base font-semibold text-neutral-900 group-hover:text-orange-700">
                  {pillar.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">{pillar.body}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">
            Six questions worth asking before you buy
          </h2>
          <p className="mt-3 leading-relaxed text-neutral-700">
            Every POS vendor&apos;s homepage looks similar. These are the questions that actually
            separate a system that holds up under a busy Friday dinner service from one that
            doesn&apos;t.
          </p>
          <div className="mt-8 space-y-5">
            {CHECKLIST.map((item, i) => (
              <div key={item.title} className="flex gap-4 rounded-xl border border-neutral-200 bg-neutral-50/60 p-5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-xs font-bold text-orange-700">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-neutral-900">{item.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-neutral-600">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Comparing your options</h2>
          <p className="mt-3 leading-relaxed text-neutral-700">
            If you&apos;re actively comparing named products, these are honest, sourced,
            feature-by-feature breakdowns rather than a sales pitch dressed up as a comparison:
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/compare/restrokendra-vs-restrohub"
              className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
            >
              RestroKendra vs. RestroHub →
            </Link>
            <Link
              href="/compare/restrokendra-vs-restrox"
              className="flex-1 rounded-xl border border-neutral-200 bg-white p-4 text-sm font-medium text-neutral-800 transition hover:border-orange-200 hover:bg-orange-50/40"
            >
              RestroKendra vs. RestroX →
            </Link>
          </div>
        </section>

        <section id="pricing" className="mt-14">
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">RestroKendra&apos;s own pricing</h2>
          <p className="mt-3 leading-relaxed text-neutral-700">
            No hidden fees, no per-order commission. Every plan includes a full 30-day free trial
            with no credit card required.
          </p>
          <div className="mt-8">
            <PricingCards plans={plans} />
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Frequently asked questions</h2>
          <div className="mt-6 space-y-6">
            {FAQ_ITEMS.map((item) => (
              <div key={item.question}>
                <h3 className="text-base font-semibold text-neutral-900">{item.question}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{item.answer}</p>
              </div>
            ))}
          </div>
        </section>
      </article>

      <MarketingCta />
    </MarketingPageShell>
  );
}
