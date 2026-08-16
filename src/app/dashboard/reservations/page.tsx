import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { ReservationsBoard } from "./ReservationsBoard";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

export default async function ReservationsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/reservations");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Reservations</h1>
        <p className="text-sm text-neutral-500">
          Table bookings for {active.name}.
        </p>
      </div>
      <ReservationsBoard
        slug={active.slug}
        canManageReservations={roleHasPermission(active.role, PERMISSIONS.MANAGE_RESERVATIONS)}
      />
    </div>
  );
}
