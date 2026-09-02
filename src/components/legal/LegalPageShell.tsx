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
    <div className="flex min-h-screen flex-col bg-surface-2">
      <header className="border-b border-hairline bg-surface-2">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset from /public */}
            <img src="/brand/logo-horizontal.png" alt="RestroKendra" className="h-8 w-auto sm:h-9" />
          </Link>
          <Link href="/" className="text-sm font-medium text-ink-muted transition hover:text-ink">
            ← Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">Last updated: {lastUpdated}</p>
        <div className="legal-content mt-10">{children}</div>
      </main>

      <footer className="border-t border-hairline/60 px-4 py-8 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-3 text-sm text-ink-muted sm:flex-row">
          <p>© {new Date().getFullYear()} RestroKendra</p>
          <nav className="flex items-center gap-5">
            <Link href="/privacy" className="transition hover:text-ink">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition hover:text-ink">
              Terms of Service
            </Link>
            <Link href="/" className="transition hover:text-ink">
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
    <div className="mb-8 rounded-xl border border-orange-500/30 bg-orange-500/15 p-4 text-sm leading-relaxed text-orange-300">
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
      <h2 className="text-xl font-bold tracking-tight text-ink">{heading}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-secondary">{children}</div>
    </section>
  );
}
