import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DhankiPOS — Restaurant Management for Itahari & Sunsari",
  description:
    "All-in-one restaurant management platform for restaurants, cafes, and momo shops in Itahari, Sunsari, and Eastern Nepal: POS, QR ordering, kitchen display, inventory, and more.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
