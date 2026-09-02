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
    <div className="min-h-screen bg-surface-1">
      <header className="flex items-center justify-between border-b border-hairline bg-surface-2 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-semibold tracking-tight text-ink">
              Restro<span className="text-orange-400">Kendra</span>
            </span>
            <span className="text-[10px] font-medium text-ink-faint">by Saugat Thapa</span>
          </span>
        </div>
        <LogoutButton />
      </header>
      <main className="mx-auto w-full max-w-lg p-4 py-16 text-center md:p-8">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/15 p-6">
          <h1 className="text-lg font-semibold text-amber-300">Down for maintenance</h1>
          <p className="mt-2 text-sm text-amber-300">
            {maintenanceMode.message ??
              "RestroKendra is temporarily unavailable while we perform scheduled maintenance. Your data is safe."}
          </p>
          <p className="mt-3 text-sm text-amber-300">Please check back shortly.</p>
        </div>
      </main>
    </div>
  );
}
