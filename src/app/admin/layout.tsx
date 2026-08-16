import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/rbac/guard";
import { LogoutButton } from "@/app/billing/LogoutButton";

/**
 * The platform admin console — deliberately its own top-level route tree
 * (not nested under /dashboard), since a platform_admin isn't "inside"
 * any single restaurant's context (their user_roles row has
 * restaurant_id = NULL, per src/lib/rbac/guard.ts's isPlatformAdmin). A
 * dashboard sidebar built around one active restaurant doesn't fit an
 * admin who oversees every tenant on the platform at once.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login?next=/admin");

  const admin = await isPlatformAdmin(session.user.id);
  if (!admin) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="text-lg font-semibold tracking-tight text-neutral-900">
            Dhanki<span className="text-orange-600">POS</span>
          </Link>
          <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
            Platform admin
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-neutral-500 sm:inline">{session.user.fullName}</span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl p-4 md:p-8">{children}</main>
    </div>
  );
}
