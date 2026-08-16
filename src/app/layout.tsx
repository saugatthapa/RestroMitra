import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RestroMitra — The Restaurant Operating System for Nepal",
  description:
    "The all-in-one restaurant operating system built for Nepal: POS, QR ordering, kitchen display, inventory, staff & branches, loyalty, account books, an AI assistant, and your own free website — one connected platform, in English or the Nepali calendar. Launching first in Itahari & Sunsari, expanding across Nepal.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
