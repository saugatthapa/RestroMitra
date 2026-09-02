import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { RegisterBoard } from "./RegisterBoard";

export default async function RegisterPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/register");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active = restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  const canManage = roleHasPermission(active.role, PERMISSIONS.MANAGE_CASH_REGISTER);
  if (!canManage) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Cash Register</h1>
        <p className="text-sm text-ink-muted">Open/close shifts and track cash for {active.name}.</p>
      </div>
      <RegisterBoard slug={active.slug} />
    </div>
  );
}
