import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { MenuManager } from "./MenuManager";

export default async function MenuPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/menu");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Menu</h1>
        <p className="text-sm text-neutral-500">
          Categories, items, variants, and add-ons for {active.name}.
        </p>
      </div>
      <MenuManager slug={active.slug} canEditPrice={active.role === "owner"} />
    </div>
  );
}
