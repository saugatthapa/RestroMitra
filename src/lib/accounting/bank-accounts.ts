import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { bankAccounts, chartOfAccounts, accountingVoucherLines, accountMappings } from "@/db/schema";
import { AccountingError } from "./post-voucher";
import { resolveAccountMappings } from "./account-mappings";
import { MAPPING_KEYS, type MappingKey } from "./account-mapping-keys";

/**
 * Phase 5, Slice 5b — real bank accounts. Per ACCOUNTING_PHASE_5_PLAN.md
 * 2.1/3 (Slice 5b) and sign-off (AskUserQuestion): each bank account a
 * restaurant adds wraps its own `chart_of_accounts` row (parented under
 * the seeded "1050 Bank Accounts" account), so the existing balance/Trial
 * Balance/Balance Sheet machinery already reports it correctly. This
 * module is the ONLY place that creates a `bank_accounts` row, and the
 * ONLY place expense/payroll/reconciliation posting resolves WHICH ledger
 * account a bank-shaped payment/reconciliation actually posts to.
 */

const BANK_ACCOUNT_PARENT_CODE = "1050";
// Reserved code block for individual bank accounts' own ledger rows — 1050
// itself is the grouping parent (never posted to directly), 1051+ are the
// auto-provisioned children, same "reserved block" convention as expense
// categories' 5200+.
const BANK_ACCOUNT_CODE_BLOCK_START = 1051;
const BANK_ACCOUNT_CODE_BLOCK_END = 1099;

export type BankAccountRow = {
  id: string;
  chartOfAccountsId: string;
  bankName: string;
  accountNumber: string | null;
  branchName: string | null;
  notes: string | null;
  isActive: boolean;
  code: string;
  accountName: string;
  createdAt: Date;
};

/**
 * Creates a new bank account: an auto-provisioned `chart_of_accounts` child
 * row (type asset, normalBalance debit, under "1050 Bank Accounts") plus
 * its `bank_accounts` metadata row, in the SAME transaction — same
 * "account + row together" shape as `resolveOrProvisionExpenseCategoryAccount`,
 * just human-triggered ("Add Bank Account") instead of on first use, so no
 * onConflictDoNothing race-recovery dance is needed here (only one human
 * action creates each row, not a concurrent posting).
 */
export async function provisionBankAccount(
  tx: Transaction,
  params: {
    restaurantId: string;
    bankName: string;
    accountNumber?: string | null;
    branchName?: string | null;
    notes?: string | null;
    createdByUserId: string;
  },
): Promise<BankAccountRow> {
  const [parent] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.restaurantId, params.restaurantId), eq(chartOfAccounts.code, BANK_ACCOUNT_PARENT_CODE)))
    .limit(1);
  if (!parent) {
    throw new AccountingError(
      "This restaurant's chart of accounts hasn't been set up yet — seed it from the Overview tab before adding a bank account.",
    );
  }

  const [{ maxCode }] = await tx
    .select({ maxCode: sql<string | null>`max(${chartOfAccounts.code})` })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.restaurantId, params.restaurantId),
        sql`${chartOfAccounts.code} ~ '^[0-9]+$'`,
        sql`${chartOfAccounts.code}::int >= ${BANK_ACCOUNT_CODE_BLOCK_START}`,
        sql`${chartOfAccounts.code}::int <= ${BANK_ACCOUNT_CODE_BLOCK_END}`,
      ),
    );
  const nextCode = maxCode ? parseInt(maxCode, 10) + 1 : BANK_ACCOUNT_CODE_BLOCK_START;
  if (nextCode > BANK_ACCOUNT_CODE_BLOCK_END) {
    throw new AccountingError("This restaurant has reached the maximum number of bank accounts supported.");
  }

  const [account] = await tx
    .insert(chartOfAccounts)
    .values({
      restaurantId: params.restaurantId,
      code: String(nextCode),
      name: params.bankName,
      type: "asset",
      normalBalance: "debit",
      parentAccountId: parent.id,
      isSystemAccount: false,
    })
    .returning({ id: chartOfAccounts.id, code: chartOfAccounts.code, name: chartOfAccounts.name });

  const [bankAccount] = await tx
    .insert(bankAccounts)
    .values({
      restaurantId: params.restaurantId,
      chartOfAccountsId: account.id,
      bankName: params.bankName,
      accountNumber: params.accountNumber || null,
      branchName: params.branchName || null,
      notes: params.notes || null,
      createdByUserId: params.createdByUserId,
    })
    .returning();

  return {
    id: bankAccount.id,
    chartOfAccountsId: account.id,
    bankName: bankAccount.bankName,
    accountNumber: bankAccount.accountNumber,
    branchName: bankAccount.branchName,
    notes: bankAccount.notes,
    isActive: bankAccount.isActive,
    code: account.code,
    accountName: account.name,
    createdAt: bankAccount.createdAt,
  };
}

/**
 * Migrates a restaurant that already has real voucher history against
 * Slice 4d/4f's single default accounts (1040 "Bank / Digital Payments",
 * 1045 "Bank Account") onto the new multi-bank-account model, per sign-off
 * (AskUserQuestion): auto-wrap each into its own `bank_accounts` row,
 * labeled "... (default)", the FIRST time this restaurant's Bank Accounts
 * screen is opened (called from that GET route — idempotent, so calling it
 * on every visit is fine and needs no separate "have I done this before"
 * flag).
 *
 * A no-op entirely if this restaurant already has ANY `bank_accounts` row
 * (already migrated, or has only ever used real bank accounts from the
 * start). Otherwise, 1040 and 1045 are each wrapped independently, and
 * ONLY if that specific account actually has posted voucher lines — a
 * restaurant that enabled accounting but never made a bank-shaped expense
 * payment, or never reconciled anything, doesn't get a meaningless empty
 * default account cluttering its bank account list; 1040/1045 simply stay
 * dormant seed accounts for it, same as today.
 *
 * Deliberately does NOT touch any historical voucher — every existing
 * voucher line keeps pointing at the exact same `chart_of_accounts` row it
 * always did; this only adds a `bank_accounts` wrapper row alongside it.
 */
export async function ensureLegacyBankAccountsWrapped(
  tx: Transaction,
  params: { restaurantId: string; wrappedByUserId: string },
): Promise<void> {
  const [{ count: existingCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(bankAccounts)
    .where(eq(bankAccounts.restaurantId, params.restaurantId));
  if (existingCount > 0) return;

  const legacyAccounts: Array<{ mappingKey: MappingKey; label: string }> = [
    { mappingKey: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS, label: "Digital Payments (default)" },
    { mappingKey: MAPPING_KEYS.BANK_ACCOUNT, label: "Bank Account (default)" },
  ];

  for (const legacy of legacyAccounts) {
    const [mapping] = await tx
      .select({ accountId: accountMappings.accountId })
      .from(accountMappings)
      .where(and(eq(accountMappings.restaurantId, params.restaurantId), eq(accountMappings.mappingKey, legacy.mappingKey)))
      .limit(1);
    if (!mapping) continue; // this restaurant hasn't even seeded accounting yet

    const hasPostedLines = await tx
      .select({ one: sql<number>`1` })
      .from(accountingVoucherLines)
      .where(eq(accountingVoucherLines.accountId, mapping.accountId))
      .limit(1);
    if (hasPostedLines.length === 0) continue; // dormant — never actually used, don't wrap it

    await tx.insert(bankAccounts).values({
      restaurantId: params.restaurantId,
      chartOfAccountsId: mapping.accountId,
      bankName: legacy.label,
      createdByUserId: params.wrappedByUserId,
    });
  }
}

/** Lists a restaurant's bank accounts (both active and inactive — the UI decides how to show inactive ones), newest first. */
export async function listBankAccounts(tx: Transaction, restaurantId: string): Promise<BankAccountRow[]> {
  const rows = await tx
    .select({
      id: bankAccounts.id,
      chartOfAccountsId: bankAccounts.chartOfAccountsId,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      branchName: bankAccounts.branchName,
      notes: bankAccounts.notes,
      isActive: bankAccounts.isActive,
      createdAt: bankAccounts.createdAt,
      code: chartOfAccounts.code,
      accountName: chartOfAccounts.name,
    })
    .from(bankAccounts)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, bankAccounts.chartOfAccountsId))
    .where(eq(bankAccounts.restaurantId, restaurantId))
    .orderBy(bankAccounts.createdAt);
  return rows;
}

/**
 * A minimal, redacted picker list — id/bankName/code for ACTIVE accounts
 * only, no account number/branch/notes — for a caller who can perform a
 * bank-shaped action (paying an expense/payroll, marking a reconciliation)
 * but doesn't hold MANAGE_ACCOUNTING itself. Per RBAC: MANAGE_ACCOUNT_BOOKS
 * is held by `manager` without MANAGE_ACCOUNTING, while PAY_EXPENSE/
 * MANAGE_PAYROLL are only ever held alongside MANAGE_ACCOUNTING (owner,
 * accountant) — so this exists specifically for the reconciliation-mark
 * picker, which is the one call site with a real permission gap.
 */
export async function listActiveBankAccountsForPicker(
  tx: Transaction,
  restaurantId: string,
): Promise<Array<{ id: string; bankName: string; code: string }>> {
  const rows = await tx
    .select({ id: bankAccounts.id, bankName: bankAccounts.bankName, code: chartOfAccounts.code })
    .from(bankAccounts)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, bankAccounts.chartOfAccountsId))
    .where(and(eq(bankAccounts.restaurantId, restaurantId), eq(bankAccounts.isActive, true)))
    .orderBy(bankAccounts.createdAt);
  return rows;
}

/**
 * Renames/edits a bank account's own metadata, or toggles it active. Toggling
 * `isActive` also toggles the WRAPPED ledger account's own `isActive` in the
 * same transaction — unlike a mapped control account (see the chart-of-
 * accounts route's own guard), a bank account's ledger row is never shared
 * via `account_mappings`, so there's no separate "is this load-bearing"
 * check needed here: deactivating the bank account and deactivating its
 * one-to-one ledger account are the same real-world action.
 */
export async function updateBankAccount(
  tx: Transaction,
  params: {
    restaurantId: string;
    bankAccountId: string;
    bankName?: string;
    accountNumber?: string | null;
    branchName?: string | null;
    notes?: string | null;
    isActive?: boolean;
  },
): Promise<BankAccountRow> {
  const [existing] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, params.bankAccountId), eq(bankAccounts.restaurantId, params.restaurantId)))
    .limit(1);
  if (!existing) {
    throw new AccountingError("Bank account not found.");
  }

  const [updated] = await tx
    .update(bankAccounts)
    .set({
      bankName: params.bankName ?? existing.bankName,
      accountNumber: params.accountNumber !== undefined ? params.accountNumber || null : existing.accountNumber,
      branchName: params.branchName !== undefined ? params.branchName || null : existing.branchName,
      notes: params.notes !== undefined ? params.notes || null : existing.notes,
      isActive: params.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(bankAccounts.id, params.bankAccountId))
    .returning();

  if (params.isActive !== undefined && params.isActive !== existing.isActive) {
    await tx
      .update(chartOfAccounts)
      .set({ isActive: params.isActive, updatedAt: new Date() })
      .where(eq(chartOfAccounts.id, existing.chartOfAccountsId));
  }

  const [account] = await tx
    .select({ code: chartOfAccounts.code, name: chartOfAccounts.name })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.id, existing.chartOfAccountsId))
    .limit(1);

  return {
    id: updated.id,
    chartOfAccountsId: updated.chartOfAccountsId,
    bankName: updated.bankName,
    accountNumber: updated.accountNumber,
    branchName: updated.branchName,
    notes: updated.notes,
    isActive: updated.isActive,
    code: account.code,
    accountName: account.name,
    createdAt: updated.createdAt,
  };
}

/**
 * Resolves WHICH ledger account a bank-shaped posting (an expense/payroll
 * payout, or Slice 4f's reconciliation) actually posts to, per sign-off
 * (AskUserQuestion, all three "Recommended" options):
 *
 * - Restaurant has NO `bank_accounts` rows at all yet (hasn't visited the
 *   new Bank Accounts screen, so hasn't migrated) — fully unchanged Slice
 *   4d/4f behavior: resolve the single legacy mapped account
 *   (`legacyMappingKey`). Every existing restaurant keeps working exactly
 *   as before until it explicitly opts into the new model.
 * - Restaurant has bank_accounts rows and exactly ONE is active — use it
 *   silently, no picker, regardless of `requestedBankAccountId` (matches
 *   "don't add a decision the user doesn't have to make yet").
 * - Restaurant has more than one active bank account — the caller MUST
 *   pass `requestedBankAccountId` (the UI shows a picker once this
 *   condition is possible); an unresolved or invalid selection throws a
 *   clear, actionable error rather than guessing.
 * - Restaurant has bank_accounts rows but NONE are active (all
 *   deactivated) — throws rather than silently falling back to the legacy
 *   mapped account, since that could repost to an account the restaurant
 *   deliberately retired.
 */
export async function resolveBankAccountForPosting(
  tx: Transaction,
  params: {
    restaurantId: string;
    requestedBankAccountId?: string | null;
    legacyMappingKey: MappingKey;
  },
): Promise<string> {
  const allRows = await tx
    .select({ id: bankAccounts.id, chartOfAccountsId: bankAccounts.chartOfAccountsId, isActive: bankAccounts.isActive })
    .from(bankAccounts)
    .where(eq(bankAccounts.restaurantId, params.restaurantId));

  if (allRows.length === 0) {
    const mapped = await resolveAccountMappings(tx, {
      restaurantId: params.restaurantId,
      keys: [params.legacyMappingKey],
    });
    return mapped.get(params.legacyMappingKey)!;
  }

  const active = allRows.filter((r) => r.isActive);

  if (params.requestedBankAccountId) {
    const match = active.find((r) => r.id === params.requestedBankAccountId);
    if (!match) {
      throw new AccountingError("The selected bank account isn't active, or doesn't belong to this restaurant.");
    }
    return match.chartOfAccountsId;
  }

  if (active.length === 1) {
    return active[0].chartOfAccountsId;
  }
  if (active.length === 0) {
    throw new AccountingError(
      "No active bank account is set up. Add or reactivate one from Bank Accounts before this can post.",
    );
  }
  throw new AccountingError(
    "This restaurant has more than one active bank account — choose which one this posting belongs to.",
  );
}

// Re-exported so callers that just need "does more than one active bank
// account exist" (to decide whether to show a picker at all) don't have to
// duplicate this query — e.g. the expense/payroll payment forms' own GET
// context, and the reconciliation mark route.
export async function countActiveBankAccounts(tx: Transaction, restaurantId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.restaurantId, restaurantId), eq(bankAccounts.isActive, true)));
  return rows[0]?.count ?? 0;
}
