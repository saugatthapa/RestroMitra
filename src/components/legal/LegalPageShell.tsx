import Link from "next/link";

/**
 * Shared shell for the public /privacy and /terms pages — Phase P0 legal
 * docs gap (see RESTROMITRA_MASTER_GAP_AUDIT.md §6). Deliberately plain:
 * this reuses the landing page's header/footer visual language (logo,
 * orange accent, neutral-900/600 text) but with none of the marketing
 * animation/gradient treatment — a policy page is read, not sold.
 */
export function LegalPageShell({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-neutral-200/70 bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset from /public */}
            <img src="/brand/logo-horizontal.png" alt="RestroMitra" className="h-8 w-auto sm:h-9" />
          </Link>
          <Link href="/" className="text-sm font-medium text-neutral-500 transition hover:text-neutral-800">
            ← Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <h1 className="text-3xl font-extrabold tracking-tight text-neutral-900 sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {lastUpdated}</p>
        <div className="legal-content mt-10">{children}</div>
      </main>

      <footer className="border-t border-neutral-100 px-4 py-8 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-3 text-sm text-neutral-500 sm:flex-row">
          <p>© {new Date().getFullYear()} RestroMitra</p>
          <nav className="flex items-center gap-5">
            <Link href="/privacy" className="transition hover:text-neutral-900">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition hover:text-neutral-900">
              Terms of Service
            </Link>
            <Link href="/" className="transition hover:text-neutral-900">
              Home
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** A callout box for the "not legal advice" disclaimer — used at the top of both policy pages. */
export function LegalDisclaimer({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-8 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm leading-relaxed text-orange-900">
      {children}
    </div>
  );
}

export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9 first:mt-0">
      <h2 className="text-xl font-bold tracking-tight text-neutral-900">{heading}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-neutral-700">{children}</div>
    </section>
  );
}
