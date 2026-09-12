import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { BillReceiptView } from "./BillReceiptView";
import { NOINDEX } from "@/lib/seo/metadata";

// Contains order/customer details — never public, same as the KOT ticket.
export const metadata: Metadata = { robots: NOINDEX };

/**
 * The narrow, thermal-receipt-style customer bill — the print-optimized
 * counterpart to OrderBillView.tsx's on-screen (full-width) bill. Sits
 * outside /dashboard for the same reason /print/kot does: DashboardShell's
 * sidebar/header chrome isn't print-hidden, and a receipt needs to print as
 * a clean narrow slip, not a dashboard page with a receipt embedded in it.
 * All the actual business/order data (restaurant name, address, phone,
 * PAN/VAT, items, totals) comes from the order detail API — this page only
 * needs the slug to know which restaurant's API to call.
 */
export default async function BillReceiptPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active = restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const { orderId } = await params;

  return <BillReceiptView slug={active.slug} orderId={orderId} />;
}
