import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { getActivePlatformRoles } from "@/lib/rbac/guard";
import { LogoutButton } from "@/app/billing/LogoutButton";

/**
 * The platform admin console — deliberately its own top-level route tree
 * (not nested under /dashboard), since a platform role isn't "inside" any
 * single restaurant's context (a platform-scoped user_roles row has
 * restaurant_id = NULL). A dashboard sidebar built around one active
 * restaurant doesn't fit an admin who oversees every tenant at once.
 *
 * This gate deliberately checks only "does this user hold ANY active
 * platform role" (platform_admin, super_admin, support_admin,
 * billing_admin, platform_viewer) — NOT MFA. MFA is enforced instead at
 * the point of actually calling a platform API (requirePlatformAdmin()/
 * requirePlatformPermission() in guard.ts). Enforcing it here too would
 * create a redirect loop for the one legitimate case of a platform-role
 * user who hasn't enabled MFA yet: they need to be able to reach
 * /admin/account to turn it on. Pages under here that fetch platform data
 * will get a clear "MFA is required..." error from the API in that case,
 * with a link below to fix it.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login?next=/admin");

  const platformRoles = await getActivePlatformRoles(session.user.id);
  if (platformRoles.length === 0) redirect("/dashboard");

  const [userRow] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const mfaEnabled = userRow?.mfaEnabled ?? false;

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="flex flex-col leading-tight">
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              Restro<span className="text-orange-600">Mitra</span>
            </span>
            <span className="text-[10px] font-medium text-neutral-400">by Saugat Thapa</span>
          </Link>
          <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
            Platform admin
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/admin/account" className="text-sm text-neutral-500 hover:text-neutral-700">
            {session.user.fullName}
          </Link>
          <LogoutButton />
        </div>
      </header>
      {!mfaEnabled && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800 md:px-6">
          Two-factor authentication is required for platform access and isn&apos;t enabled on
          your account yet.{" "}
          <Link href="/admin/account" className="underline hover:text-amber-900">
            Enable it now
          </Link>{" "}
          — every action here will be rejected until you do.
        </div>
      )}
      <nav className="border-b border-neutral-200 bg-white px-4 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl gap-4 text-sm">
          <Link
            href="/admin"
            className="border-b-2 border-transparent py-2.5 text-neutral-600 hover:border-orange-600 hover:text-neutral-900"
          >
            Restaurants
          </Link>
          <Link
            href="/admin/platform-roles"
            className="border-b-2 border-transparent py-2.5 text-neutral-600 hover:border-orange-600 hover:text-neutral-900"
          >
            Platform admins
          </Link>
          <Link
            href="/admin/plans"
            className="border-b-2 border-transparent py-2.5 text-neutral-600 hover:border-orange-600 hover:text-neutral-900"
          >
            Plans
          </Link>
          <Link
            href="/admin/feature-flags"
            className="border-b-2 border-transparent py-2.5 text-neutral-600 hover:border-orange-600 hover:text-neutral-900"
          >
            Feature flags
          </Link>
          <Link
            href="/admin/audit-log"
            className="border-b-2 border-transparent py-2.5 text-neutral-600 hover:border-orange-600 hover:text-neutral-900"
          >
            Audit log
          </Link>
        </div>
      </nav>
      <main className="mx-auto w-full max-w-6xl p-4 md:p-8">{children}</main>
    </div>
  );
}
