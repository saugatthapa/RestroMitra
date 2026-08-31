/**
 * Platform Control Center — permission catalog.
 *
 * Mirrors src/lib/rbac/permissions.ts's shape exactly (a flat string-key
 * catalog + a default role->permissions matrix + a pure `roleHasX` check),
 * but for the platform-authorization realm: actions that operate across
 * every tenant rather than within one restaurant. Tenant RBAC
 * (permissions.ts) and this catalog are deliberately separate — a
 * restaurant's own `manager`/`accountant`/etc. roles have no bearing here,
 * and a platform role has no bearing on tenant RBAC (a support_admin
 * doesn't get MANAGE_STAFF anywhere just by holding a platform role).
 *
 * See PLATFORM_CONTROL_CENTER_IMPLEMENTATION_PLAN.md, Phase 1.
 */

export const PLATFORM_PERMISSIONS = {
  // Tenant visibility/management
  VIEW_TENANTS: "view_tenants",
  MANAGE_TENANTS: "manage_tenants", // suspend/reactivate, edit tenant-level fields

  // Subscriptions / billing
  MANAGE_SUBSCRIPTIONS: "manage_subscriptions", // state transitions, trial extend/shorten/convert
  MANAGE_PLANS: "manage_plans", // plan catalog, pricing

  // Entitlements (Phase 5) — feature flags + per-tenant overrides
  MANAGE_ENTITLEMENTS: "manage_entitlements",

  // Platform audit log (Phase 6)
  VIEW_PLATFORM_AUDIT_LOG: "view_platform_audit_log",

  // AI Provider Control Center (Phase 7)
  MANAGE_AI_PROVIDERS: "manage_ai_providers",

  // Impersonation (Phase 8) — IMPERSONATE_TENANT alone grants read-only
  // access (see the impersonation session's default `mode`); mutating
  // while impersonating additionally requires IMPERSONATE_TENANT_WRITE,
  // deliberately not bundled into the base permission so a role can see a
  // tenant's dashboard for support purposes without also being able to
  // change it.
  IMPERSONATE_TENANT: "impersonate_tenant",
  IMPERSONATE_TENANT_WRITE: "impersonate_tenant_write",

  // Support tooling (Phase 9)
  MANAGE_SUPPORT: "manage_support", // internal notes, session revocation, status tags, search

  // Announcements / system ops (Phase 10)
  MANAGE_ANNOUNCEMENTS: "manage_announcements",
  MANAGE_SYSTEM: "manage_system", // maintenance mode, /admin/system, break-glass access

  // Granting/revoking platform roles themselves — deliberately the single
  // most sensitive permission in this catalog. Only platform_admin and
  // super_admin hold it (see the matrix below); none of the three narrower
  // roles can escalate themselves or anyone else, even each other.
  MANAGE_PLATFORM_ADMINS: "manage_platform_admins",
} as const;

export type PlatformPermissionKey =
  (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

export const PLATFORM_PERMISSION_DESCRIPTIONS: Record<PlatformPermissionKey, string> = {
  [PLATFORM_PERMISSIONS.VIEW_TENANTS]: "View the tenant list and tenant detail pages",
  [PLATFORM_PERMISSIONS.MANAGE_TENANTS]: "Suspend, reactivate, or edit a tenant",
  [PLATFORM_PERMISSIONS.MANAGE_SUBSCRIPTIONS]:
    "Change a tenant's subscription state, extend/shorten/convert a trial",
  [PLATFORM_PERMISSIONS.MANAGE_PLANS]: "Create or edit plans in the platform's plan catalog",
  [PLATFORM_PERMISSIONS.MANAGE_ENTITLEMENTS]:
    "Manage feature flags and per-tenant entitlement overrides",
  [PLATFORM_PERMISSIONS.VIEW_PLATFORM_AUDIT_LOG]: "View the platform-level audit log",
  [PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS]:
    "Configure AI provider credentials, failover, and usage limits",
  [PLATFORM_PERMISSIONS.IMPERSONATE_TENANT]:
    "Start an audited, read-only impersonation session for a tenant",
  [PLATFORM_PERMISSIONS.IMPERSONATE_TENANT_WRITE]:
    "Make changes to a tenant while impersonating it (requires IMPERSONATE_TENANT)",
  [PLATFORM_PERMISSIONS.MANAGE_SUPPORT]:
    "Use support tooling: internal notes, session revocation, status tags, global search",
  [PLATFORM_PERMISSIONS.MANAGE_ANNOUNCEMENTS]: "Create or edit platform announcements",
  [PLATFORM_PERMISSIONS.MANAGE_SYSTEM]:
    "Access system health, maintenance mode, and break-glass emergency actions",
  [PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS]: "Grant or revoke platform roles for a user",
};

export const PLATFORM_ROLES = [
  "platform_admin",
  "super_admin",
  "support_admin",
  "billing_admin",
  "platform_viewer",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isPlatformRole(role: string): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}

/**
 * platform_admin and super_admin are full-access tiers (bypass this matrix
 * entirely, same "owner/platform_admin bypass the matrix" convention
 * permissions.ts already uses for tenant RBAC) — the ONLY distinction
 * between them is MANAGE_PLATFORM_ADMINS, which super_admin also holds
 * explicitly for symmetry/clarity even though the bypass already covers it.
 * The three narrower roles are graded individually and never granted
 * MANAGE_PLATFORM_ADMINS, so none of them (nor any combination of them) can
 * create a new platform role grant — only an existing platform_admin/
 * super_admin can.
 */
export const PLATFORM_DEFAULT_ROLE_PERMISSIONS: Record<
  Exclude<PlatformRole, "platform_admin" | "super_admin">,
  PlatformPermissionKey[]
> = {
  support_admin: [
    PLATFORM_PERMISSIONS.VIEW_TENANTS,
    PLATFORM_PERMISSIONS.VIEW_PLATFORM_AUDIT_LOG,
    PLATFORM_PERMISSIONS.MANAGE_SUPPORT,
    PLATFORM_PERMISSIONS.IMPERSONATE_TENANT,
  ],
  billing_admin: [
    PLATFORM_PERMISSIONS.VIEW_TENANTS,
    PLATFORM_PERMISSIONS.MANAGE_SUBSCRIPTIONS,
    PLATFORM_PERMISSIONS.MANAGE_PLANS,
    PLATFORM_PERMISSIONS.VIEW_PLATFORM_AUDIT_LOG,
  ],
  platform_viewer: [
    PLATFORM_PERMISSIONS.VIEW_TENANTS,
    PLATFORM_PERMISSIONS.VIEW_PLATFORM_AUDIT_LOG,
  ],
};

const FULL_ACCESS_PLATFORM_ROLES: readonly string[] = ["platform_admin", "super_admin"];

/**
 * Pure check: does holding `role` (a single platform-role string) grant
 * `permission`? Mirrors permissions.ts's roleHasPermission exactly. Callers
 * that need "does this USER (who may hold several platform role grants at
 * once) have this permission" should check every active role they hold via
 * this function (see guard.ts's requirePlatformPermission), not assume one
 * role per user — user_roles intentionally allows multiple concurrent
 * platform-scoped grants per user (see schema.ts's user_roles_one_active_
 * per_restaurant_unique index, which excludes restaurantId IS NULL rows).
 */
export function roleHasPlatformPermission(role: string, permission: PlatformPermissionKey): boolean {
  if (FULL_ACCESS_PLATFORM_ROLES.includes(role)) return true;
  const granted =
    PLATFORM_DEFAULT_ROLE_PERMISSIONS[
      role as keyof typeof PLATFORM_DEFAULT_ROLE_PERMISSIONS
    ];
  return granted?.includes(permission) ?? false;
}
