import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { ExpensesBoard } from "./ExpensesBoard";

export default async function ExpensesPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/expenses");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  const canCreate = roleHasPermission(active.role, PERMISSIONS.CREATE_EXPENSE_REQUEST);
  const canManage = roleHasPermission(active.role, PERMISSIONS.MANAGE_EXPENSES);
  const canApprove = roleHasPermission(active.role, PERMISSIONS.APPROVE_EXPENSE);
  const canPay = roleHasPermission(active.role, PERMISSIONS.PAY_EXPENSE);

  // A role with none of the expense permissions shouldn't reach this page
  // at all — the sidebar already hides the nav link (DashboardShell); this
  // redirect is what actually enforces it against a direct URL hit.
  if (!canCreate && !canManage && !canApprove && !canPay) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Expenses</h1>
        <p className="text-sm text-neutral-500">
          Operational spending for {active.name}.
        </p>
      </div>
      <ExpensesBoard
        slug={active.slug}
        canCreate={canCreate}
        canManage={canManage}
        canApprove={canApprove}
        canPay={canPay}
      />
    </div>
  );
}
