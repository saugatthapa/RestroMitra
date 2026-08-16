/**
 * Seeds fixed, non-tenant data: the permission catalog and the default
 * role -> permission matrix. Safe to run repeatedly (upserts).
 *
 * Usage: npm run db:seed
 */
import "./load-env";
import { db } from "./index";
import { permissions, rolePermissions } from "./schema";
import {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  DEFAULT_ROLE_PERMISSIONS,
} from "@/lib/rbac/permissions";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Seeding permissions…");
  for (const key of Object.values(PERMISSIONS)) {
    await db
      .insert(permissions)
      .values({ key, description: PERMISSION_DESCRIPTIONS[key] })
      .onConflictDoUpdate({
        target: permissions.key,
        set: { description: PERMISSION_DESCRIPTIONS[key] },
      });
  }

  console.log("Seeding role_permissions…");
  for (const [role, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const key of keys) {
      await db
        .insert(rolePermissions)
        .values({
          role: role as (typeof rolePermissions.role.enumValues)[number],
          permissionKey: key,
        })
        .onConflictDoNothing();
    }
  }

  console.log("Done.");
  await db.execute(sql`select 1`); // sanity check connection was live
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
