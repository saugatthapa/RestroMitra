import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getMaintenanceMode } from "@/lib/system/maintenance-mode-db";
import { LogoutButton } from "@/app/billing/LogoutButton";

/**
 * Platform Control Center (Phase 10) — a deliberately top-level route
 * (NOT under /dashboard), same reasoning as /suspended and /billing: the
 * dashboard layout redirects a non-admin, non-impersonating user here
 * while maintenance mode is on, so this page has to be reachable
 * regardless of that same state or the redirect would loop into itself.
 *
 * If maintenance mode has since been turned off (someone left this tab
 * open), this page redirects back into /dashboard rather than leaving
 * the person stuck looking at a stale notice.
 */
export default async function MaintenancePage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard");

  const maintenanceMode = await getMaintenanceMode();
  if (!maintenanceMode.enabled) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              Restro<span className="text-orange-600">Mitra</span>
            </span>
            <span className="text-[10px] font-medium text-neutral-400">by Saugat Thapa</span>
          </span>
        </div>
        <LogoutButton />
      </header>
      <main className="mx-auto w-full max-w-lg p-4 py-16 text-center md:p-8">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
          <h1 className="text-lg font-semibold text-amber-900">Down for maintenance</h1>
          <p className="mt-2 text-sm text-amber-800">
            {maintenanceMode.message ??
              "RestroMitra is temporarily unavailable while we perform scheduled maintenance. Your data is safe."}
          </p>
          <p className="mt-3 text-sm text-amber-800">Please check back shortly.</p>
        </div>
      </main>
    </div>
  );
}
