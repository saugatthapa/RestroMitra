import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { KotTicketView } from "./KotTicketView";

/**
 * Deliberately OUTSIDE the /dashboard route segment — /dashboard/layout.tsx
 * wraps everything under it in DashboardShell (sidebar, header, restaurant
 * switcher), which Next.js has no way to opt a nested route out of, and
 * none of that chrome is print-hidden today. A Kitchen Order Ticket needs
 * to print as a clean, narrow, receipt-style page — printing the whole
 * dashboard shell around it would defeat the point. This route sits at the
 * app root instead, inheriting only the minimal root layout.
 */
export default async function KotTicketPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const { orderId } = await params;

  return (
    <KotTicketView
      slug={active.slug}
      orderId={orderId}
      restaurantName={active.name}
      kotHeaderText={active.kotHeaderText}
    />
  );
}
