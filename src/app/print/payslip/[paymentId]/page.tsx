import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PayslipView } from "./PayslipView";
import { NOINDEX } from "@/lib/seo/metadata";

// Contains a staff member's name, pay, and payment method — real PII,
// never indexable.
export const metadata: Metadata = { robots: NOINDEX };

/**
 * Commercial completion pass — payslip generation. Sits outside /dashboard
 * for the same reason src/app/print/kot/[orderId] does (see that route's
 * own comment): a payslip needs to print as a clean standalone document,
 * not with the dashboard's sidebar/header chrome around it.
 */
export default async function PayslipPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const { paymentId } = await params;

  return <PayslipView slug={active.slug} paymentId={paymentId} />;
}
