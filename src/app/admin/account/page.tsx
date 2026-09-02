import { AccountSettingsBoard } from "@/app/dashboard/account/AccountSettingsBoard";

/**
 * Platform Control Center (Phase 1) — a platform-admin-console-scoped copy
 * of /dashboard/account's URL, not its route. /dashboard/account lives
 * under DashboardLayout, which redirects to /onboarding for anyone with
 * zero tenant restaurant roles — exactly the case for a platform-only
 * user (support_admin, billing_admin, platform_viewer, or a platform_admin/
 * super_admin who isn't also an owner/staff member anywhere). Reusing the
 * same AccountSettingsBoard component (change password, sessions, MFA
 * enrollment — all account-level, not restaurant-scoped) here, under
 * AdminLayout instead, gives every platform-role user a reachable place to
 * turn MFA on — the one prerequisite requirePlatformAdmin()/
 * requirePlatformPermission() actually enforce (see guard.ts) — without
 * needing a tenant role first.
 */
export default function AdminAccountPage() {
  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">My Account</h1>
        <p className="text-sm text-ink-muted">
          Two-factor authentication is required before you can use the platform admin console.
        </p>
      </div>
      <AccountSettingsBoard />
    </div>
  );
}
