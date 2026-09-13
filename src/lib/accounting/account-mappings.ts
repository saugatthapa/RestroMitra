import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
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

/**
 * Phase 4, Slice 4d — resolves the `expense_category:<categoryId>` mapping
 * for one expense category, auto-provisioning both the chart_of_accounts
 * row and the mapping itself the first time a category is actually paid,
 * per ACCOUNTING_PHASE_4_PLAN.md Part 2.5 (approved: auto-provision over
 * requiring a human to map every category up front). Unlike the fixed
 * `MAPPING_KEYS`, an expense category is user-created and open-ended, so
 * there's no seed data to rely on — this is the one place that gap gets
 * filled, lazily, inside the same transaction as the posting that needed
 * it.
 *
 * Every insert below uses `onConflictDoNothing` rather than a try/catch
 * around a thrown unique-violation: a caught error would otherwise poison
 * this whole Postgres transaction (any statement error aborts it until
 * rollback, with no savepoint in play here), putting the caller's own
 * `postVoucher()` call — running in the SAME transaction right after this
 * returns — at risk of failing on an otherwise-healthy connection. Instead,
 * a code collision (this restaurant already has an account at the code
 * this call computed) or a mapping-key collision (a concurrent transaction
 * provisioned the SAME category first) are both resolved entirely at the
 * SQL level: retry the next code, or fall back to whichever mapping
 * actually won. A losing transaction's own just-inserted account row is
 * left behind, unused — a harmless, rare extra row, not a correctness
 * problem.
 */
export async function resolveOrProvisionExpenseCategoryAccount(
  tx: Transaction,
  params: { restaurantId: string; categoryId: string; categoryName: string },
): Promise<{ accountId: string; autoProvisioned: { id: string; code: string; name: string } | null }> {
  const mappingKey = `expense_category:${params.categoryId}`;

  const [existing] = await tx
    .select({ accountId: accountMappings.accountId, isActive: chartOfAccounts.isActive })
    .from(accountMappings)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountMappings.accountId))
    .where(and(eq(accountMappings.restaurantId, params.restaurantId), eq(accountMappings.mappingKey, mappingKey)))
    .limit(1);
  if (existing) {
    if (!existing.isActive) {
      throw new AccountingError(
        `Automatic posting is misconfigured: the account mapped to the "${params.categoryName}" expense category has been deactivated. Reactivate it (or remap it) from the Chart of Accounts before this can post.`,
      );
    }
    return { accountId: existing.accountId, autoProvisioned: null };
  }

  // Next free code in the 5200+ block the posting matrix reserves for
  // per-category expense accounts (5000/5100 are the fixed COGS/Salary
  // accounts the default seed already creates).
  const [{ maxCode }] = await tx
    .select({ maxCode: sql<string | null>`max(${chartOfAccounts.code})` })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.restaurantId, params.restaurantId),
        sql`${chartOfAccounts.code} ~ '^[0-9]+$'`,
        sql`${chartOfAccounts.code}::int >= 5200`,
      ),
    );
  let nextCodeNum = maxCode ? parseInt(maxCode, 10) + 10 : 5200;

  let newAccount: { id: string; code: string; name: string } | undefined;
  for (let attempt = 0; attempt < 5 && !newAccount; attempt++) {
    const [row] = await tx
      .insert(chartOfAccounts)
      .values({
        restaurantId: params.restaurantId,
        code: String(nextCodeNum),
        name: params.categoryName,
        type: "expense",
        normalBalance: "debit",
        isSystemAccount: false,
      })
      .onConflictDoNothing({ target: [chartOfAccounts.restaurantId, chartOfAccounts.code] })
      .returning({ id: chartOfAccounts.id, code: chartOfAccounts.code, name: chartOfAccounts.name });
    if (row) {
      newAccount = row;
    } else {
      nextCodeNum += 1; // someone else just took this exact code — try the next one
    }
  }
  if (!newAccount) {
    throw new AccountingError(
      `Could not create a new account for the "${params.categoryName}" expense category. Please try again, or map it manually from the Chart of Accounts.`,
    );
  }

  const [mapping] = await tx
    .insert(accountMappings)
    .values({ restaurantId: params.restaurantId, mappingKey, accountId: newAccount.id })
    .onConflictDoNothing({ target: [accountMappings.restaurantId, accountMappings.mappingKey] })
    .returning({ id: accountMappings.id });

  if (!mapping) {
    // Lost the race to map this exact category to a concurrent transaction
    // that committed first — use the winner's account, not the one just
    // created above.
    const [winner] = await tx
      .select({ accountId: accountMappings.accountId })
      .from(accountMappings)
      .where(and(eq(accountMappings.restaurantId, params.restaurantId), eq(accountMappings.mappingKey, mappingKey)))
      .limit(1);
    return { accountId: winner.accountId, autoProvisioned: null };
  }

  return { accountId: newAccount.id, autoProvisioned: newAccount };
}
