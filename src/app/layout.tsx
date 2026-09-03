import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { getSiteUrl } from "@/lib/seo/site";
import { getGaMeasurementId } from "@/lib/seo/analytics";

export const metadata: Metadata = {
  // Resolves every relative URL any page's metadata emits (OpenGraph/
  // Twitter images, etc.) against the app's real absolute URL — see
  // src/lib/seo/site.ts. Without this, Next can't turn a root-relative
  // og:image path into the absolute URL crawlers/social previews require.
  metadataBase: new URL(getSiteUrl()),
  title: "RestroKendra — The Restaurant Operating System for Nepal",
  description:
    "The all-in-one restaurant operating system built for Nepal: POS, QR ordering, kitchen display, inventory, staff & branches, loyalty, account books, an AI assistant, and your own free website — one connected platform, in English or the Nepali calendar. Launching first in Itahari & Sunsari, expanding across Nepal.",
  // Phase 22 (offline mode / installable app) — manifest.json + the
  // Apple-specific web-app tags below are what let a staff member's phone
  // offer "Add to Home Screen" / actually install this as a standalone app
  // (no address bar) instead of just being a bookmark to a browser tab.
  // Chrome/Edge/Android read manifest.json directly; iOS Safari ignores it
  // and needs these separate apple-* tags for the same effect — see
  // InstallAppPrompt.tsx for the two platforms' very different install UX.
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "RestroKendra",
  },
};

export const viewport: Viewport = {
  themeColor: "#ea580c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const gaId = getGaMeasurementId();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {/* Google Analytics (gtag.js) — installed manually per Google's own
            setup instructions. next/script's "afterInteractive" strategy is
            Next.js's documented recommendation for GA: it loads after the
            page is interactive rather than blocking the initial render,
            while still firing early enough to capture the pageview. Only
            rendered when a measurement ID resolves (see getGaMeasurementId)
            — i.e. never in local development. */}
        {gaId && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${gaId}');
              `}
            </Script>
          </>
        )}
        {children}
      </body>
    </html>
  );
}
