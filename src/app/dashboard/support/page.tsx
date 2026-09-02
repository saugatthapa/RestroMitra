import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { SupportTicketsBoard } from "./SupportTicketsBoard";

// Gap audit P1 — restaurant-owner-facing support tickets. Deliberately
// open to any staff member with an active role grant on this restaurant
// (no permission check here, same tier as Orders/KDS in the nav) rather
// than owner/manager-only: any staff member should be able to flag an
// issue to the platform team, not just the owner.
export default async function SupportPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/support");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Support</h1>
        <p className="text-sm text-ink-muted">
          File an issue with the RestroKendra team and track it here — from a billing question to
          something broken in the app.
        </p>
      </div>
      <SupportTicketsBoard slug={active.slug} />
    </div>
  );
}
