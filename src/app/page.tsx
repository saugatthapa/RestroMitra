import Link from "next/link";
import { Reveal } from "@/components/landing/Reveal";
import { FaqAccordion, type FaqItem } from "@/components/landing/FaqAccordion";
import { MobileNav } from "@/components/landing/MobileNav";

// Deliberately no next/font/google pull here — a webfont is bytes and a
// font-swap the system stack already defined in globals.css doesn't pay
// at all. Zero download, zero layout shift, and it still reads as
// intentional at these font-weights/tracking; the "fast, low latency"
// goal wins over a marginally more distinctive typeface.

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#compare", label: "Compare" },
  { href: "#faq", label: "FAQ" },
];

type Feature = { title: string; desc: string; icon: React.ReactNode };

const FEATURES: Feature[] = [
  {
    title: "QR table ordering",
    desc: "Customers scan, browse the live menu, and order straight from their phone — no app install, no waiting for a waiter.",
    icon: <IconQr />,
  },
  {
    title: "POS & billing",
    desc: "Fast staff-side order entry with split payments across cash, card, and mobile wallets, priced server-side down to the paisa.",
    icon: <IconReceipt />,
  },
  {
    title: "Kitchen display (KDS)",
    desc: "Tickets route to the right station automatically and update live — no shouted orders, no lost slips.",
    icon: <IconMonitor />,
  },
  {
    title: "Inventory & recipes",
    desc: "Recipe-linked stock that deducts itself the moment an order is placed, with weighted-average costing built in.",
    icon: <IconBox />,
  },
  {
    title: "Staff & attendance",
    desc: "Role-based logins for every position, with self-service clock-in/out and a live shift roster.",
    icon: <IconUsers />,
  },
  {
    title: "Customers & loyalty",
    desc: "A searchable CRM with an automatic Bronze-to-Platinum points program that rewards repeat regulars.",
    icon: <IconHeart />,
  },
  {
    title: "Expense tracking",
    desc: "A category-tagged ledger for rent, utilities, and supplies, so your real costs sit right next to your sales.",
    icon: <IconWallet />,
  },
  {
    title: "Reservations",
    desc: "A day-scoped booking book with its own status flow, from requested through seated to completed.",
    icon: <IconCalendar />,
  },
  {
    title: "Reports & analytics",
    desc: "Revenue vs. expenses trends, top-selling items, and payment breakdowns for any date range, at a glance.",
    icon: <IconChart />,
  },
];

const STEPS = [
  {
    number: "01",
    title: "Set up in minutes",
    desc: "Add your menu, tables, and staff. No hardware to buy, no installation — it runs in the browser you already have.",
  },
  {
    number: "02",
    title: "Take orders your way",
    desc: "Customers scan a table QR code, or staff key it in on the POS. Every price is computed and verified server-side.",
  },
  {
    number: "03",
    title: "Everything stays in sync",
    desc: "The kitchen, billing, inventory, and your reports update in real time — one system, not six disconnected tools.",
  },
];

type CompareRow = { label: string; dhankipos: string; manual: string; generic: string };

const COMPARE_ROWS: CompareRow[] = [
  { label: "Real-time kitchen display", dhankipos: "Included", manual: "—", generic: "Sometimes" },
  { label: "QR self-ordering", dhankipos: "Included", manual: "—", generic: "Extra add-on" },
  { label: "Recipe-based stock deduction", dhankipos: "Automatic", manual: "Manual counts", generic: "Rare" },
  { label: "Role-based staff permissions", dhankipos: "Built in", manual: "—", generic: "Basic" },
  { label: "Loyalty & customer CRM", dhankipos: "Included", manual: "—", generic: "Extra add-on" },
  { label: "NPR paisa-accurate billing", dhankipos: "Exact", manual: "Error-prone", generic: "Varies" },
  { label: "Built for Eastern Nepal", dhankipos: "Yes", manual: "—", generic: "Generic template" },
  { label: "Setup time", dhankipos: "Minutes", manual: "N/A", generic: "Days to weeks" },
];

const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Do I need to install anything or buy hardware?",
    answer:
      "No. DhankiPOS runs entirely in your browser — on a phone, tablet, or computer you already own. There's nothing to install, and a receipt printer is optional, not required.",
  },
  {
    question: "How much does it cost after the trial?",
    answer:
      "Pricing plans are being finalized as we roll out. Every new restaurant starts with a full 30-day free trial and no credit card required, so you can try the whole platform risk-free first.",
  },
  {
    question: "Is my restaurant's data safe?",
    answer:
      "Yes. Every restaurant's data is completely isolated from every other restaurant on the platform, access is controlled by role-based permissions, and sensitive actions are logged for accountability.",
  },
  {
    question: "Can my whole team use it at once?",
    answer:
      "Yes — invite your manager, cashiers, waiters, and kitchen staff, each with their own login and exactly the permissions their role needs. Nobody sees more than they should.",
  },
  {
    question: "What if I only run a small tea shop or momo cart?",
    answer:
      "DhankiPOS scales down as easily as it scales up. Use just the POS and billing if that's all you need today, and turn on QR ordering, inventory, or reports whenever you're ready for them.",
  },
  {
    question: "Can I cancel anytime?",
    answer: "Yes — there's no long-term contract to sign. Cancel anytime, directly from your dashboard.",
  },
];

export default function LandingPage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-clip bg-white">
      {/* ---------------------------------------------------------------- Header */}
      <header className="sticky top-0 z-50 border-b border-neutral-200/70 bg-white/75 backdrop-blur-md">
        <div className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="group flex items-center gap-2">
            <LogoMark />
            <span className="text-lg font-bold tracking-tight text-neutral-900">
              Dhanki<span className="text-orange-600">POS</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-7 sm:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="nav-link text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-3 sm:flex">
            <Link
              href="/login"
              className="nav-link text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900"
            >
              Log in
            </Link>
            <Link href="/register" className="btn-primary btn-shine text-sm">
              Start free trial
            </Link>
          </div>

          <MobileNav />
        </div>
      </header>

      {/* ---------------------------------------------------------------- Hero */}
      <section className="relative isolate overflow-clip px-4 pt-16 pb-20 sm:px-6 sm:pt-24 sm:pb-28">
        {/* Ambient gradient blobs — decorative only, aria-hidden, pure CSS
            transform/opacity animation so they never touch layout. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          <div className="animate-blob absolute -top-24 left-1/2 h-[28rem] w-[28rem] -translate-x-[70%] rounded-full bg-orange-200/50 blur-3xl" />
          <div className="animate-blob-delayed absolute top-10 left-1/2 h-[24rem] w-[24rem] translate-x-[10%] rounded-full bg-amber-100/60 blur-3xl" />
        </div>

        <div className="mx-auto flex w-full max-w-6xl flex-col items-center text-center">
          <span className="animate-hero-in mb-5 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3.5 py-1.5 text-xs font-semibold text-orange-700">
            <span className="animate-pulse-ring h-1.5 w-1.5 rounded-full bg-orange-500" />
            Built for restaurants, cafes &amp; momo shops in Itahari &amp; Sunsari
          </span>

          <h1
            className="animate-hero-in max-w-3xl text-4xl leading-[1.08] font-extrabold tracking-tight text-neutral-900 sm:text-5xl md:text-6xl"
            style={{ animationDelay: "80ms" }}
          >
            The modern way to{" "}
            <span className="bg-gradient-to-r from-orange-600 via-orange-500 to-amber-500 bg-clip-text text-transparent">
              run your restaurant
            </span>
          </h1>

          <p
            className="animate-hero-in mt-5 max-w-xl text-base text-neutral-600 sm:text-lg"
            style={{ animationDelay: "160ms" }}
          >
            QR ordering, POS, kitchen display, inventory, staff, loyalty, and real-time
            reports — one fast platform, not six disconnected tools stitched together.
          </p>

          <div
            className="animate-hero-in mt-8 flex flex-col items-center gap-3 sm:flex-row"
            style={{ animationDelay: "240ms" }}
          >
            <Link href="/register" className="btn-primary btn-shine px-6 py-3 text-base">
              Start your 30-day free trial
              <ArrowRight />
            </Link>
            <a href="#how-it-works" className="btn-secondary px-6 py-3 text-base">
              See how it works
            </a>
          </div>
          <p
            className="animate-hero-in mt-4 text-xs text-neutral-400"
            style={{ animationDelay: "300ms" }}
          >
            No credit card required · No hardware to buy · Cancel anytime
          </p>

          {/* Floating product mockup */}
          <div className="relative mt-16 h-[19rem] w-full max-w-3xl sm:mt-20 sm:h-[24rem]">
            <div className="hero-float-card animate-float absolute top-0 left-1/2 w-[19rem] -translate-x-1/2 cursor-default rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl shadow-orange-900/10 sm:w-[26rem]">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-500">Today&apos;s sales</span>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                  Live
                </span>
              </div>
              <p className="text-3xl font-extrabold text-neutral-900">Rs 42,860</p>
              <MockSparkline />
            </div>

            <div className="hero-float-card animate-float-delayed absolute top-4 -left-2 w-40 cursor-default rounded-xl border border-neutral-200 bg-white p-3 shadow-xl shadow-neutral-900/10 sm:left-6">
              <span className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
                Table 4
              </span>
              <p className="mt-1 text-sm font-semibold text-neutral-900">2× Chicken Momo</p>
              <p className="text-sm text-neutral-500">1× Cold Drink</p>
              <span className="mt-2 inline-block rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                Preparing
              </span>
            </div>

            <div className="hero-float-card animate-float-slow absolute right-0 bottom-2 w-44 cursor-default rounded-xl border border-neutral-200 bg-white p-3 shadow-xl shadow-neutral-900/10 sm:right-4">
              <span className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
                Loyalty
              </span>
              <p className="mt-1 text-sm font-semibold text-neutral-900">Sunita Rai</p>
              <p className="text-xs text-neutral-500">1,240 pts · Gold tier</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Differentiators strip */}
      <Reveal>
        <section className="border-y border-neutral-100 bg-neutral-50/70 py-8">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-6 px-4 text-center sm:grid-cols-4 sm:px-6">
            {[
              "30-day free trial",
              "No credit card required",
              "Built for Eastern Nepal",
              "One connected system",
            ].map((item) => (
              <div
                key={item}
                className="group flex items-center justify-center gap-2 text-sm font-medium text-neutral-600 transition-colors duration-200 hover:text-neutral-900"
              >
                <CheckCircle />
                {item}
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      {/* ---------------------------------------------------------------- Features */}
      <section id="features" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Features</span>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
            Everything a restaurant needs, already talking to each other
          </h2>
          <p className="mt-4 text-neutral-600">
            No plugins to configure and no separate logins to juggle — every module below
            shares the same menu, the same orders, and the same real-time data.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delayMs={(i % 3) * 90}>
              <div className="feature-card group h-full rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-orange-200 hover:shadow-lg hover:shadow-orange-900/5">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-600 transition-all duration-300 ease-out group-hover:scale-110 group-hover:-rotate-6 group-hover:bg-orange-600 group-hover:text-white">
                  {feature.icon}
                </div>
                <h3 className="mt-4 text-base font-semibold text-neutral-900 transition-colors group-hover:text-orange-700">
                  {feature.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">{feature.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- How it works */}
      <section id="how-it-works" className="border-t border-neutral-100 bg-neutral-50/70 px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto w-full max-w-6xl">
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">
              How it works
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
              From order to receipt, in three steps
            </h2>
          </Reveal>

          <div className="relative mt-16 grid grid-cols-1 gap-10 sm:grid-cols-3">
            <div
              aria-hidden="true"
              className="absolute top-6 right-[16.5%] left-[16.5%] hidden h-px bg-gradient-to-r from-orange-200 via-orange-300 to-orange-200 sm:block"
            />
            {STEPS.map((step, i) => (
              <Reveal key={step.number} delayMs={i * 120} className="group relative text-center sm:text-left">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border-2 border-orange-500 bg-white text-sm font-bold text-orange-600 transition-all duration-300 group-hover:scale-110 group-hover:bg-orange-600 group-hover:text-white group-hover:shadow-lg group-hover:shadow-orange-300/50 sm:mx-0">
                  {step.number}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-neutral-900 transition-colors group-hover:text-orange-700">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-600">{step.desc}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Comparison */}
      <section id="compare" className="mx-auto w-full max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">Compare</span>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
            Better than paper, faster than a generic system
          </h2>
          <p className="mt-4 text-neutral-600">
            Spreadsheets and register tape don&apos;t talk to your kitchen. Generic,
            one-size-fits-all POS software wasn&apos;t built with Nepal&apos;s restaurants in
            mind. DhankiPOS was.
          </p>
        </Reveal>

        <Reveal className="mt-12 overflow-hidden rounded-2xl border border-neutral-200 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="bg-neutral-50 text-left text-xs font-semibold tracking-wide text-neutral-500 uppercase">
                  <th className="px-5 py-3.5">Capability</th>
                  <th className="bg-orange-50 px-5 py-3.5 text-orange-700">DhankiPOS</th>
                  <th className="px-5 py-3.5">Paper &amp; spreadsheets</th>
                  <th className="px-5 py-3.5">Generic POS software</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row, i) => (
                  <tr
                    key={row.label}
                    className={`transition-colors duration-200 hover:bg-orange-50/60 ${
                      i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"
                    }`}
                  >
                    <td className="px-5 py-3.5 font-medium text-neutral-800">{row.label}</td>
                    <td className="bg-orange-50/60 px-5 py-3.5 font-semibold text-orange-700">
                      {row.dhankipos}
                    </td>
                    <td className="px-5 py-3.5 text-neutral-500">{row.manual}</td>
                    <td className="px-5 py-3.5 text-neutral-500">{row.generic}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </section>

      {/* ---------------------------------------------------------------- CTA banner */}
      <Reveal className="px-4 sm:px-6">
        <section className="relative mx-auto w-full max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-orange-600 via-orange-500 to-amber-500 px-6 py-16 text-center shadow-xl sm:py-20">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="animate-blob absolute -top-16 -left-16 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
            <div className="animate-blob-delayed absolute -right-10 -bottom-16 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          </div>
          <div className="relative">
            <h2 className="mx-auto max-w-xl text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Ready to modernize your restaurant?
            </h2>
            <p className="mx-auto mt-4 max-w-md text-orange-50">
              Set up your menu and start taking orders today. Free for 30 days — no credit
              card, no hardware, no risk.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/register"
                className="btn-shine inline-flex items-center justify-center rounded-lg bg-white px-6 py-3 text-base font-semibold text-orange-700 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:bg-orange-50 hover:shadow-lg active:translate-y-0"
              >
                Start your 30-day free trial
                <ArrowRight color="currentColor" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-lg border border-white/40 px-6 py-3 text-base font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:bg-white/10 active:translate-y-0"
              >
                Log in
              </Link>
            </div>
          </div>
        </section>
      </Reveal>

      {/* ---------------------------------------------------------------- FAQ */}
      <section id="faq" className="mx-auto w-full max-w-3xl px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="text-center">
          <span className="text-xs font-semibold tracking-wide text-orange-600 uppercase">FAQ</span>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">
            Questions restaurant owners ask us
          </h2>
        </Reveal>
        <Reveal className="mt-12" delayMs={80}>
          <FaqAccordion items={FAQ_ITEMS} />
        </Reveal>
      </section>

      {/* ---------------------------------------------------------------- Footer */}
      <footer className="border-t border-neutral-100 px-4 py-12 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col items-center sm:items-start">
            <Link href="/" className="group flex items-center gap-2">
              <LogoMark />
              <span className="text-base font-bold tracking-tight text-neutral-900">
                Dhanki<span className="text-orange-600">POS</span>
              </span>
            </Link>
            <p className="mt-2 max-w-xs text-center text-xs text-neutral-400 sm:text-left">
              An independent restaurant management platform, built for Itahari, Sunsari,
              and Eastern Nepal.
            </p>
          </div>

          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-neutral-500 sm:justify-end">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="nav-link transition-colors hover:text-neutral-900">
                {link.label}
              </a>
            ))}
            <Link href="/login" className="nav-link transition-colors hover:text-neutral-900">
              Log in
            </Link>
            <Link
              href="/register"
              className="nav-link font-medium text-orange-600 transition-colors hover:text-orange-700"
            >
              Start free trial
            </Link>
          </nav>
        </div>
        <p className="mt-8 text-center text-xs text-neutral-400">
          © {new Date().getFullYear()} DhankiPOS. All rights reserved.
        </p>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------------
 * Small presentational pieces — inline SVGs rather than an icon-library
 * dependency, same "keep the marketing bundle light" reasoning as the
 * CSS-only animations above.
 * --------------------------------------------------------------------- */

function LogoMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-600 text-white shadow-sm transition-transform duration-500 ease-out group-hover:rotate-6 group-hover:scale-105">
      <svg viewBox="0 0 24 24" fill="none" className="h-4.5 w-4.5">
        <path
          d="M6 3v7a2 2 0 0 0 2 2v9M6 3v6M8 3v6M10 3v6M10 3v18M18 3c-2.2 0-4 2.2-4 6s1.8 6 4 6v9"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ArrowRight({ color }: { color?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="ml-1.5 h-4 w-4" style={color ? { color } : undefined}>
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckCircle() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4 flex-none text-orange-500 transition-transform duration-300 group-hover:scale-125"
    >
      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 10.2l2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MockSparkline() {
  return (
    <svg viewBox="0 0 240 56" fill="none" className="mt-3 h-14 w-full">
      <path
        d="M0 42 L24 38 L48 44 L72 28 L96 32 L120 18 L144 24 L168 12 L192 20 L216 8 L240 14"
        stroke="#ea580c"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M0 42 L24 38 L48 44 L72 28 L96 32 L120 18 L144 24 L168 12 L192 20 L216 8 L240 14 L240 56 L0 56 Z"
        fill="url(#sparkline-fill)"
        opacity="0.5"
      />
      <defs>
        <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fb923c" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fb923c" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function IconQr() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <rect x="3" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM19 19h2v2h-2z" fill="currentColor" />
    </svg>
  );
}
function IconReceipt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path
        d="M6 2h12v20l-2.5-1.5L13 22l-2.5-1.5L8 22l-2-1.5V2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 7h6M9 11h6M9 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconMonitor() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <rect x="3" y="4" width="18" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7 9h4M7 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconBox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path d="M3 8l9-5 9 5-9 5-9-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M3 8v9l9 5 9-5V8M12 13v9" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 4.5a3.2 3.2 0 0 1 0 6.4M21 20c0-2.8-2-5.1-4.6-5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconHeart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path
        d="M12 20.5s-7.5-4.6-9.7-9.1C.8 8.1 2.4 4.5 6 4c2.2-.3 4.2.9 6 2.9C13.8 4.9 15.8 3.7 18 4c3.6.5 5.2 4.1 3.7 7.4-2.2 4.5-9.7 9.1-9.7 9.1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconWallet() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 10h18M15 14.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7 6V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function IconCalendar() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 14h2M14 14h2M8 17h2M14 17h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path d="M4 20V10M11 20V4M18 20v-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 20h19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
