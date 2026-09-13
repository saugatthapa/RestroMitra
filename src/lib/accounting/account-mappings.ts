import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Transaction } from "@/db";
import { accountMappings, chartOfAccounts } from "@/db/schema";
import { AccountingError } from "./post-voucher";
import type { MappingKey } from "./account-mapping-keys";

/**
 * Phase 4 — batch-resolves a set of account_mappings keys to their live
 * account ids, for the automatic integrations to build voucher lines from.
 * One query per call site (not one per line), joined to chart_of_accounts
 * so an inactive mapped account is caught here rather than surfacing as a
 * more confusing "inactive account" error later inside postVoucher()
 * itself.
 *
 * Throws AccountingError if ANY requested key has no mapping row, or maps
 * to an inactive account — by design (see ACCOUNTING_PHASE_4_PLAN.md Part
 * 1/2.1): this should only ever actually throw for a restaurant whose
 * accounting setup is broken (e.g. a system-mapped account was
 * deactivated after automatic posting was enabled — see the chart-of-
 * accounts route's own guard against that). It is never called at all for
 * a restaurant that hasn't enabled automatic posting — every call site
 * checks `restaurant.automaticPostingEnabledAt` first — so a restaurant
 * that has simply never set up accounting never reaches this function.
 */
export async function resolveAccountMappings(
  tx: Transaction,
  params: { restaurantId: string; keys: MappingKey[] },
): Promise<Map<MappingKey, string>> {
  if (params.keys.length === 0) return new Map();

  // Dedupe — a caller building a line set conditionally (e.g. only the
  // payment methods actually used on this order) may still end up asking
  // for the same key twice in one call; the query doesn't care, but the
  // "every requested key must resolve" check below should complain about
  // distinct missing keys, not double-count one.
  const uniqueKeys = Array.from(new Set(params.keys));

  const rows = await tx
    .select({
      mappingKey: accountMappings.mappingKey,
      accountId: accountMappings.accountId,
      isActive: chartOfAccounts.isActive,
    })
    .from(accountMappings)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountMappings.accountId))
    .where(
      and(eq(accountMappings.restaurantId, params.restaurantId), inArray(accountMappings.mappingKey, uniqueKeys)),
    );

  const resolved = new Map<MappingKey, string>();
  const inactive: string[] = [];
  for (const row of rows) {
    if (!row.isActive) {
      inactive.push(row.mappingKey);
      continue;
    }
    resolved.set(row.mappingKey as MappingKey, row.accountId);
  }

  const missing = uniqueKeys.filter((k) => !resolved.has(k) && !inactive.includes(k));
  if (inactive.length > 0) {
    throw new AccountingError(
      `Automatic posting is misconfigured: the account mapped to "${inactive[0]}" has been deactivated. Reactivate it (or remap it) from the Chart of Accounts before this can post.`,
    );
  }
  if (missing.length > 0) {
    throw new AccountingError(
      `Automatic posting is misconfigured: no account is mapped to "${missing[0]}". Set one up from the Chart of Accounts before this can post.`,
    );
  }

  return resolved;
}
