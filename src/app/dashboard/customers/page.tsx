import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { CustomersBoard } from "./CustomersBoard";

export default async function CustomersPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/customers");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // A role without MANAGE_CUSTOMERS shouldn't reach this page at all — the
  // sidebar already hides the nav link (DashboardShell); this redirect is
  // what actually enforces it against a direct URL hit.
  if (!roleHasPermission(active.role, PERMISSIONS.MANAGE_CUSTOMERS)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Customers</h1>
        <p className="text-sm text-neutral-500">
          CRM and loyalty program for {active.name}.
        </p>
      </div>
      <CustomersBoard
        slug={active.slug}
        canManageCustomers={roleHasPermission(active.role, PERMISSIONS.MANAGE_CUSTOMERS)}
        canManageAccountBooks={roleHasPermission(active.role, PERMISSIONS.MANAGE_ACCOUNT_BOOKS)}
      />
    </div>
  );
}
