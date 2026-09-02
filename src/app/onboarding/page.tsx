import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { OnboardingWizard } from "./OnboardingWizard";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/onboarding");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length > 0) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="mx-auto max-w-xl">
        <div className="mb-8 flex flex-col leading-tight">
          <span className="text-lg font-semibold tracking-tight text-neutral-900">
            Restro<span className="text-orange-600">Mitra</span>
          </span>
          <span className="text-[10px] font-medium text-neutral-400">by Saugat Thapa</span>
        </div>
        <OnboardingWizard ownerName={session.user.fullName} />
      </div>
    </div>
  );
}
