import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { DailyClosingBoard } from "./DailyClosingBoard";

export default async function DailyClosingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/daily-closing");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active = restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_DAILY_CLOSING)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Daily Closing</h1>
        <p className="text-sm text-neutral-500">End-of-day snapshot and close-out for {active.name}.</p>
      </div>
      <DailyClosingBoard slug={active.slug} />
    </div>
  );
}
