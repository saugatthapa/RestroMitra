import Link from "next/link";
import { AuthMarketingPanel } from "@/components/auth/AuthMarketingPanel";
import { LogoMark } from "@/components/Logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface-1">
      {/* Form column — full width on mobile/tablet where the marketing
          panel is hidden, a fixed-ish share of the screen from `lg` up. */}
      <div className="flex w-full flex-col justify-center px-4 py-10 sm:px-8 lg:w-[48%] lg:px-14 xl:w-[42%]">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between">
            <Link
              href="/"
              className="text-sm font-medium text-ink-muted transition hover:text-ink"
            >
              ← Back
            </Link>
            <Link href="/" className="group flex items-center gap-2">
              <LogoMark className="h-7 w-7" />
              <span className="flex flex-col leading-tight">
                <span className="text-lg font-semibold tracking-tight text-ink">
                  Restro<span className="text-orange-400">Kendra</span>
                </span>
                <span className="text-[10px] font-medium text-ink-faint">by Saugat Thapa</span>
              </span>
            </Link>
          </div>
          {children}
        </div>
      </div>

      {/* Marketing panel — hidden below `lg` rather than stacked, since a
          second full-height red/orange panel below the form on mobile
          would just be scroll-past filler with no functional value there. */}
      <div className="hidden lg:block lg:w-[52%] xl:w-[58%]">
        <AuthMarketingPanel />
      </div>
    </div>
  );
}
