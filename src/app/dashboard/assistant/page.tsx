import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { AssistantChat } from "./AssistantChat";

function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}

export default async function AssistantPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/assistant");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // Same permission the Reports dashboard requires — this assistant only
  // ever answers from that same sales/expense data.
  if (!roleHasPermission(active.role, PERMISSIONS.VIEW_REPORTS)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">AI Assistant</h1>
        <p className="text-sm text-neutral-500">
          Ask about {active.name}&rsquo;s sales, top items, and expenses over the last 30 days.
        </p>
      </div>
      <AssistantChat slug={active.slug} />
    </div>
  );
}
