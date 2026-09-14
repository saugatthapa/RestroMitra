import "server-only";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import {
  bankAccounts,
  bankReconciliationClearedLines,
  bankReconciliations,
  accountingVoucherLines,
  accountingVouchers,
} from "@/db/schema";
import { AccountingError } from "./post-voucher";

/**
 * Phase 5, Slice 5b — bank-STATEMENT-level reconciliation. Distinct from
 * `integrations/reconciliation.ts` (Slice 4f), which posts an accounting
 * voucher the moment a single PAYMENT is confirmed against a bank/gateway
 * statement. This module is a level up: it's the periodic checklist that
 * confirms a whole BANK ACCOUNT's ledger balance matches the real bank
 * statement at a point in time — the same "manual checklist, no bank-API
 * integration" spirit (see that file's own doc comment), just operating on
 * the running list of everything ever posted to that bank account's ledger
 * account, not one payment at a time.
 *
 * The core arithmetic (see completeBankReconciliation): the running total
 * of every voucher line ever "cleared" (checked off) against a bank
 * account, across every reconciliation ever completed for it, should equal
 * that statement's own closing balance, once this reconciliation is
 * complete. A real mismatch isn't blocked — it's recorded as
 * `differenceInPaisa` for a human to investigate (e.g. a bank fee the
 * ledger hasn't recorded yet).
 */

export type ReconciliationLine = {
  id: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  narration: string | null;
  description: string | null;
  debitInPaisa: number;
  creditInPaisa: number;
  cleared: boolean;
};

async function loadOwnedReconciliation(tx: Transaction, restaurantId: string, reconciliationId: string) {
  const [row] = await tx
    .select()
    .from(bankReconciliations)
    .where(and(eq(bankReconciliations.id, reconciliationId), eq(bankReconciliations.restaurantId, restaurantId)))
    .limit(1);
  if (!row) throw new AccountingError("Bank reconciliation not found.");
  return row;
}

/** Lists a restaurant's bank reconciliations, optionally narrowed to one bank account, newest statement first. */
export async function listBankReconciliations(
  tx: Transaction,
  params: { restaurantId: string; bankAccountId?: string },
) {
  return tx
    .select()
    .from(bankReconciliations)
    .where(
      and(
        eq(bankReconciliations.restaurantId, params.restaurantId),
        params.bankAccountId ? eq(bankReconciliations.bankAccountId, params.bankAccountId) : undefined,
      ),
    )
    .orderBy(desc(bankReconciliations.statementDate), desc(bankReconciliations.createdAt));
}

/**
 * Creates a new "open" reconciliation for one bank account and statement
 * date/closing balance. The bank account must belong to this restaurant
 * and be active — a deactivated bank account has no reason to gain a new
 * reconciliation.
 */
export async function createBankReconciliation(
  tx: Transaction,
  params: {
    restaurantId: string;
    bankAccountId: string;
    statementDate: string;
    statementClosingBalanceInPaisa: number;
    notes?: string | null;
    createdByUserId: string;
  },
) {
  const [account] = await tx
    .select({ id: bankAccounts.id, isActive: bankAccounts.isActive })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, params.bankAccountId), eq(bankAccounts.restaurantId, params.restaurantId)))
    .limit(1);
  if (!account) throw new AccountingError("Bank account not found.");
  if (!account.isActive) throw new AccountingError("This bank account is inactive — reactivate it before reconciling.");

  const [row] = await tx
    .insert(bankReconciliations)
    .values({
      restaurantId: params.restaurantId,
      bankAccountId: params.bankAccountId,
      statementDate: params.statementDate,
      statementClosingBalanceInPaisa: params.statementClosingBalanceInPaisa,
      notes: params.notes || null,
      createdByUserId: params.createdByUserId,
    })
    .returning();
  return row;
}

/**
 * Returns the reconciliation itself plus every one of its bank account's
 * own posted voucher lines dated on or before the statement date, EXCEPT
 * lines already cleared by a DIFFERENT reconciliation (those belong to
 * that other checklist, not this one) — each tagged `cleared: true/false`
 * for whether THIS reconciliation has checked it off.
 */
export async function getReconciliationWorkspace(
  tx: Transaction,
  params: { restaurantId: string; reconciliationId: string },
): Promise<{ reconciliation: typeof bankReconciliations.$inferSelect; lines: ReconciliationLine[] }> {
  const reconciliation = await loadOwnedReconciliation(tx, params.restaurantId, params.reconciliationId);

  const [account] = await tx
    .select({ chartOfAccountsId: bankAccounts.chartOfAccountsId })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, reconciliation.bankAccountId))
    .limit(1);
  if (!account) throw new AccountingError("This reconciliation's bank account no longer exists.");

  const rows = await tx
    .select({
      id: accountingVoucherLines.id,
      voucherId: accountingVoucherLines.voucherId,
      voucherNumber: accountingVouchers.voucherNumber,
      voucherType: accountingVouchers.voucherType,
      voucherDate: accountingVouchers.voucherDate,
      narration: accountingVouchers.narration,
      description: accountingVoucherLines.description,
      debitInPaisa: accountingVoucherLines.debitInPaisa,
      creditInPaisa: accountingVoucherLines.creditInPaisa,
      clearedByReconciliationId: bankReconciliationClearedLines.reconciliationId,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVoucherLines.voucherId, accountingVouchers.id))
    .leftJoin(
      bankReconciliationClearedLines,
      eq(bankReconciliationClearedLines.voucherLineId, accountingVoucherLines.id),
    )
    .where(
      and(
        eq(accountingVouchers.restaurantId, params.restaurantId),
        eq(accountingVoucherLines.accountId, account.chartOfAccountsId),
        lte(accountingVouchers.voucherDate, reconciliation.statementDate),
      ),
    )
    .orderBy(asc(accountingVouchers.voucherDate), asc(accountingVoucherLines.createdAt));

  const lines: ReconciliationLine[] = rows
    .filter((r) => r.clearedByReconciliationId === null || r.clearedByReconciliationId === params.reconciliationId)
    .map((r) => ({
      id: r.id,
      voucherId: r.voucherId,
      voucherNumber: r.voucherNumber,
      voucherType: r.voucherType,
      voucherDate: r.voucherDate,
      narration: r.narration,
      description: r.description,
      debitInPaisa: r.debitInPaisa,
      creditInPaisa: r.creditInPaisa,
      cleared: r.clearedByReconciliationId === params.reconciliationId,
    }));

  return { reconciliation, lines };
}

/**
 * Replaces this (still-open) reconciliation's checked-off set with exactly
 * `voucherLineIds`. Lines currently cleared here but absent from the new
 * set are unchecked (their cleared-line row deleted, freeing them for a
 * future reconciliation); lines newly present are inserted via
 * `onConflictDoNothing` on the voucher-line unique index — never a
 * try/catch around a thrown unique violation, same "don't poison this
 * transaction" reasoning as `resolveOrProvisionExpenseCategoryAccount` —
 * so a line some OTHER concurrent reconciliation just claimed first is
 * silently skipped rather than erroring the whole request; the return
 * value tells the caller which ones didn't take, so the UI can say so.
 */
export async function setClearedLines(
  tx: Transaction,
  params: { restaurantId: string; reconciliationId: string; voucherLineIds: string[] },
): Promise<{ skipped: string[] }> {
  const reconciliation = await loadOwnedReconciliation(tx, params.restaurantId, params.reconciliationId);
  if (reconciliation.status !== "open") {
    throw new AccountingError("This reconciliation is already completed — reopen it before changing what's checked off.");
  }

  const desired = new Set(params.voucherLineIds);

  const current = await tx
    .select({ voucherLineId: bankReconciliationClearedLines.voucherLineId })
    .from(bankReconciliationClearedLines)
    .where(eq(bankReconciliationClearedLines.reconciliationId, params.reconciliationId));
  const currentIds = new Set(current.map((c) => c.voucherLineId));

  const toRemove = [...currentIds].filter((id) => !desired.has(id));
  const toAdd = [...desired].filter((id) => !currentIds.has(id));

  if (toRemove.length > 0) {
    await tx
      .delete(bankReconciliationClearedLines)
      .where(
        and(
          eq(bankReconciliationClearedLines.reconciliationId, params.reconciliationId),
          inArray(bankReconciliationClearedLines.voucherLineId, toRemove),
        ),
      );
  }

  const skipped: string[] = [];
  if (toAdd.length > 0) {
    const inserted = await tx
      .insert(bankReconciliationClearedLines)
      .values(toAdd.map((voucherLineId) => ({ reconciliationId: params.reconciliationId, voucherLineId })))
      .onConflictDoNothing({ target: [bankReconciliationClearedLines.voucherLineId] })
      .returning({ voucherLineId: bankReconciliationClearedLines.voucherLineId });
    const insertedIds = new Set(inserted.map((i) => i.voucherLineId));
    for (const id of toAdd) {
      if (!insertedIds.has(id)) skipped.push(id);
    }
  }

  return { skipped };
}

/**
 * Completes an open reconciliation: computes the running cumulative total
 * of every voucher line ever cleared against this bank account (across
 * every completed reconciliation for it, plus this one being completed
 * now) dated on or before the statement date, and compares it to the
 * statement's own closing balance.
 *
 * Why this is the right comparison (worked through once, here, rather than
 * re-derived at every call site): a voucher line can only ever be cleared
 * by ONE reconciliation, ever (the unique index on voucherLineId), so
 * "cleared by this reconciliation" and "cleared by any other COMPLETED
 * reconciliation for the same bank account" are mutually exclusive by
 * construction. Their combined net (debits minus credits) is exactly the
 * portion of the ledger balance that has ever been confirmed against a
 * real bank statement — which, if every reconciliation to date was done
 * correctly, is exactly what the bank's own running balance reflects as of
 * this statement date. A nonzero `differenceInPaisa` means something is
 * off (a missed line, a bank fee not yet posted, a data error) and is
 * surfaced for a human to investigate — never silently forced to zero.
 *
 * `bookBalanceInPaisa` (the ledger's own balance for this account as of
 * the statement date, regardless of cleared status) is recorded alongside
 * purely for display — "book says X, statement says Y, difference Z."
 */
export async function completeBankReconciliation(
  tx: Transaction,
  params: { restaurantId: string; reconciliationId: string; completedByUserId: string },
) {
  const reconciliation = await loadOwnedReconciliation(tx, params.restaurantId, params.reconciliationId);
  if (reconciliation.status !== "open") {
    throw new AccountingError("This reconciliation is already completed.");
  }

  const [account] = await tx
    .select({ chartOfAccountsId: bankAccounts.chartOfAccountsId })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, reconciliation.bankAccountId))
    .limit(1);
  if (!account) throw new AccountingError("This reconciliation's bank account no longer exists.");

  const [bookBalanceRow] = await tx
    .select({
      net: sql<number>`coalesce(sum(${accountingVoucherLines.debitInPaisa} - ${accountingVoucherLines.creditInPaisa}), 0)::int`,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVoucherLines.voucherId, accountingVouchers.id))
    .where(
      and(
        eq(accountingVouchers.restaurantId, params.restaurantId),
        eq(accountingVoucherLines.accountId, account.chartOfAccountsId),
        lte(accountingVouchers.voucherDate, reconciliation.statementDate),
      ),
    );
  const bookBalanceInPaisa = bookBalanceRow?.net ?? 0;

  const [clearedRow] = await tx
    .select({
      net: sql<number>`coalesce(sum(${accountingVoucherLines.debitInPaisa} - ${accountingVoucherLines.creditInPaisa}), 0)::int`,
    })
    .from(bankReconciliationClearedLines)
    .innerJoin(accountingVoucherLines, eq(accountingVoucherLines.id, bankReconciliationClearedLines.voucherLineId))
    .innerJoin(accountingVouchers, eq(accountingVoucherLines.voucherId, accountingVouchers.id))
    .innerJoin(bankReconciliations, eq(bankReconciliations.id, bankReconciliationClearedLines.reconciliationId))
    .where(
      and(
        eq(accountingVouchers.restaurantId, params.restaurantId),
        eq(bankReconciliations.bankAccountId, reconciliation.bankAccountId),
        lte(accountingVouchers.voucherDate, reconciliation.statementDate),
        sql`(${bankReconciliations.id} = ${params.reconciliationId} OR ${bankReconciliations.status} = 'completed')`,
      ),
    );
  const clearedNetCumulative = clearedRow?.net ?? 0;

  const differenceInPaisa = clearedNetCumulative - reconciliation.statementClosingBalanceInPaisa;

  const [updated] = await tx
    .update(bankReconciliations)
    .set({
      status: "completed",
      bookBalanceInPaisa,
      differenceInPaisa,
      completedByUserId: params.completedByUserId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankReconciliations.id, params.reconciliationId))
    .returning();

  return updated;
}

/**
 * Reopens a completed reconciliation for correction (a wrong statement
 * closing balance, a missed line) — clears its completion fields but
 * leaves every already-cleared line checked, since "this line appeared on
 * the statement" stays true regardless; reopening is for fixing the
 * reconciliation's OWN bookkeeping, not undoing confirmed clears (uncheck
 * individual lines via `setClearedLines` afterward if one was wrong).
 */
export async function reopenBankReconciliation(
  tx: Transaction,
  params: { restaurantId: string; reconciliationId: string },
) {
  const reconciliation = await loadOwnedReconciliation(tx, params.restaurantId, params.reconciliationId);
  if (reconciliation.status !== "completed") {
    throw new AccountingError("This reconciliation is not completed.");
  }

  const [updated] = await tx
    .update(bankReconciliations)
    .set({
      status: "open",
      bookBalanceInPaisa: null,
      differenceInPaisa: null,
      completedByUserId: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(bankReconciliations.id, params.reconciliationId))
    .returning();
  return updated;
}

/** Deletes an abandoned, still-open reconciliation (cascades its cleared-line rows). A completed one can never be deleted — reopen it instead if it needs correcting. */
export async function deleteOpenBankReconciliation(
  tx: Transaction,
  params: { restaurantId: string; reconciliationId: string },
): Promise<void> {
  const reconciliation = await loadOwnedReconciliation(tx, params.restaurantId, params.reconciliationId);
  if (reconciliation.status !== "open") {
    throw new AccountingError("A completed reconciliation can't be deleted — reopen it instead if it needs correcting.");
  }
  await tx.delete(bankReconciliations).where(eq(bankReconciliations.id, params.reconciliationId));
}
