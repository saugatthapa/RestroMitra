import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { TicketThread } from "./TicketThread";

export default async function SupportTicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/support");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];
  const { ticketId } = await params;

  return <TicketThread slug={active.slug} ticketId={ticketId} />;
}
