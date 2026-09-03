import Link from "next/link";

/**
 * Shared header/footer for the SEO content pages built in the SEO pass
 * (pillar page, feature pages, /compare/*, /alternatives/*) — reuses the
 * landing page's visual language (logo, orange accent, brand-navy footer)
 * at LegalPageShell's level of restraint (no scroll animation/gradient
 * blobs) since these are read-and-decide pages, not the primary sales
 * pitch. Content width is wider than LegalPageShell's (article prose) to
 * fit comparison tables and multi-column feature grids.
 */
export function MarketingPageShell({
  children,
  contentClassName = "max-w-4xl",
}: {
  children: React.ReactNode;
  /** Override the <main> max-width — e.g. wider for a table-heavy compare page. */
  contentClassName?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-50 border-b border-neutral-200/70 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="group flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset from /public */}
            <img
              src="/brand/logo-horizontal.png"
              alt="RestroKendra"
              className="h-9 w-auto transition-transform duration-500 ease-out group-hover:scale-105"
            />
          </Link>
          <nav className="hidden items-center gap-6 sm:flex">
            <Link href="/restaurant-pos-nepal" className="text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900">
              Restaurant POS guide
            </Link>
            <Link href="/#features" className="text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900">
              Features
            </Link>
            <Link href="/#pricing" className="text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900">
              Pricing
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="hidden text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900 sm:inline">
              Log in
            </Link>
            <Link href="/register" className="btn-primary btn-shine text-sm">
              Start free trial
            </Link>
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 px-4 py-12 sm:px-6 sm:py-16 ${contentClassName}`}>{children}</main>

      <footer className="bg-brand-navy px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col items-center sm:items-start">
            <Link href="/" className="group flex items-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset from /public */}
              <img
                src="/brand/logo-horizontal.png"
                alt="RestroKendra"
                className="h-11 w-auto transition-transform duration-500 ease-out group-hover:scale-105"
              />
            </Link>
            <p className="mt-2 max-w-xs text-center text-xs text-neutral-400 sm:text-left">
              An independent restaurant management platform, launching first in Itahari and
              Sunsari — built for restaurants across Nepal.
            </p>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-neutral-300 sm:justify-end">
            <Link href="/restaurant-pos-nepal" className="transition-colors hover:text-white">
              Restaurant POS guide
            </Link>
            <Link href="/features/qr-ordering" className="transition-colors hover:text-white">
              QR ordering
            </Link>
            <Link href="/features/kds" className="transition-colors hover:text-white">
              Kitchen display
            </Link>
            <Link href="/features/inventory" className="transition-colors hover:text-white">
              Inventory
            </Link>
            <Link href="/login" className="transition-colors hover:text-white">
              Log in
            </Link>
            <Link href="/register" className="font-medium text-orange-400 transition-colors hover:text-orange-300">
              Start free trial
            </Link>
          </nav>
        </div>
        <div className="mt-8 flex flex-col items-center gap-3 border-t border-white/10 pt-8 sm:flex-row sm:justify-center sm:gap-6">
          <p className="text-xs text-neutral-400">© {new Date().getFullYear()} RestroKendra · by Saugat Thapa</p>
          <span className="hidden text-neutral-600 sm:inline" aria-hidden="true">·</span>
          <nav className="flex items-center gap-4 text-xs text-neutral-400">
            <Link href="/privacy" className="transition-colors hover:text-neutral-200">Privacy Policy</Link>
            <Link href="/terms" className="transition-colors hover:text-neutral-200">Terms of Service</Link>
            <Link href="/" className="transition-colors hover:text-neutral-200">Home</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** Visible breadcrumb trail — pairs with createBreadcrumbSchema so the on-page nav and the JSON-LD never drift apart (same items, two renderings). */
export function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
      {items.map((item, i) => (
        <span key={item.path} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">/</span>}
          {i === items.length - 1 ? (
            <span className="font-medium text-neutral-700">{item.name}</span>
          ) : (
            <Link href={item.path} className="transition-colors hover:text-neutral-800">
              {item.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Standard bottom CTA banner, reused across every SEO content page. */
export function MarketingCta({
  heading = "Ready to modernize your restaurant?",
  body = "Set up your menu and start taking orders today. Free for 30 days — no credit card, no hardware, no risk.",
}: {
  heading?: string;
  body?: string;
}) {
  return (
    <section className="relative mt-16 overflow-hidden rounded-3xl bg-gradient-to-br from-orange-600 via-orange-500 to-amber-500 px-6 py-14 text-center shadow-xl">
      <h2 className="mx-auto max-w-xl text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{heading}</h2>
      <p className="mx-auto mt-3 max-w-md text-sm text-orange-50 sm:text-base">{body}</p>
      <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          href="/register"
          className="btn-shine inline-flex items-center justify-center rounded-lg bg-white px-6 py-3 text-base font-semibold text-orange-700 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:bg-orange-50 hover:shadow-lg active:translate-y-0"
        >
          Start your 30-day free trial
        </Link>
        <Link
          href="/#pricing"
          className="inline-flex items-center justify-center rounded-lg border border-white/40 px-6 py-3 text-base font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:bg-white/10 active:translate-y-0"
        >
          See pricing
        </Link>
      </div>
    </section>
  );
}
