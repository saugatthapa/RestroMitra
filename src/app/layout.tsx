import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
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
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
