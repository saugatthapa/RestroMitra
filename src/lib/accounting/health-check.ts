import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accountingVoucherLines, accountingVouchers, chartOfAccounts } from "@/db/schema";
import { getAccountBalances } from "./balances";
import { getAccountsPayableAging, getAccountsReceivableAging } from "./aging";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 7, Slice 7e — the Accounting Health validator. Per
 * ACCOUNTING_PHASE_7_PLAN.md §2.5: read-only diagnostics that surface
 * anything that looks wrong for a human to investigate. This module never
 * writes anything and never "fixes" a discrepancy — auto-repair of
 * financial data is exactly the kind of action this engagement treats as
 * needing explicit human judgment, not code. Every check below only
 * ever reads.
 *
 * Three severities, not two, because the plan itself calls for
 * distinguishing "needs investigation" from "definite error":
 *   - "pass" — nothing found.
 *   - "info" — found something, but it's an expected, benign state (a
 *     deactivated account that still has old history) — not a defect.
 *   - "attention" — found something that should never happen given this
 *     module's own invariants (an unbalanced voucher, a balance that
 *     doesn't reconcile) and genuinely warrants a look.
 */

export type HealthCheckSeverity = "pass" | "info" | "attention";

export type HealthCheckIssue = { message: string };

export type HealthCheckId =
  | "balanceConsistency"
  | "voucherBalance"
  | "deactivatedAccountsWithActivity"
  | "arApReconciliation"
  | "orphanedLines";

export type HealthCheck = {
  id: HealthCheckId;
  label: string;
  description: string;
  severity: HealthCheckSeverity;
  issues: HealthCheckIssue[];
};

export type AccountingHealthReport = {
  restaurantId: string;
  asOfDate: string;
  generatedAt: string;
  overallSeverity: HealthCheckSeverity;
  checks: HealthCheck[];
};

function severityFor(issueCount: number, whenFound: HealthCheckSeverity): HealthCheckSeverity {
  return issueCount === 0 ? "pass" : whenFound;
}

/**
 * Every account's balance, recomputed independently of `getAccountBalances`'
 * own app-side `reduce` — this check deliberately does NOT call into that
 * function's arithmetic, it re-derives the same numbers via a SQL-side
 * `GROUP BY`/`sum()` instead (the pattern this codebase already uses
 * elsewhere, e.g. `reports.ts`'s `getTopMenuItems`; `balances.ts` chose
 * app-side aggregation for its own documented reasons, but a validator
 * whose entire job is "does this agree with a second, independent
 * computation" needs an actually different code path, not the same
 * reduce called twice). If a future change to either implementation
 * causes them to diverge, this is what catches it.
 */
async function checkBalanceConsistency(restaurantId: string): Promise<HealthCheck> {
  const { accounts } = await getAccountBalances({ restaurantId });

  const rows = await db
    .select({
      accountId: accountingVoucherLines.accountId,
      totalDebitInPaisa: sql<string>`sum(${accountingVoucherLines.debitInPaisa})`,
      totalCreditInPaisa: sql<string>`sum(${accountingVoucherLines.creditInPaisa})`,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .where(eq(accountingVouchers.restaurantId, restaurantId))
    .groupBy(accountingVoucherLines.accountId);

  const recomputed = new Map(rows.map((r) => [r.accountId, { debit: Number(r.totalDebitInPaisa), credit: Number(r.totalCreditInPaisa) }]));

  const issues: HealthCheckIssue[] = [];
  for (const account of accounts) {
    const cross = recomputed.get(account.accountId) ?? { debit: 0, credit: 0 };
    if (cross.debit !== account.totalDebitInPaisa || cross.credit !== account.totalCreditInPaisa) {
      issues.push({
        message: `${account.code} — ${account.name}: the report's own total debit/credit (${account.totalDebitInPaisa}/${account.totalCreditInPaisa} paisa) disagrees with an independent recomputation from the same voucher lines (${cross.debit}/${cross.credit} paisa).`,
      });
    }
  }

  return {
    id: "balanceConsistency",
    label: "Account balances agree with the ledger",
    description:
      "Recomputes every account's total debit/credit directly from accounting_voucher_lines (a separate query path from the one reports use) and compares it against what the reports actually show.",
    severity: severityFor(issues.length, "attention"),
    issues,
  };
}

/**
 * `postVoucher()` enforces debit = credit at write time (see its own
 * comment on the 3200 write-guard precedent), so this should be
 * structurally impossible — checking it directly is cheap and catches any
 * future code path that bypasses `postVoucher()`.
 */
async function checkVoucherBalance(restaurantId: string): Promise<HealthCheck> {
  const rows = await db
    .select({
      voucherId: accountingVoucherLines.voucherId,
      voucherNumber: accountingVouchers.voucherNumber,
      totalDebitInPaisa: sql<string>`sum(${accountingVoucherLines.debitInPaisa})`,
      totalCreditInPaisa: sql<string>`sum(${accountingVoucherLines.creditInPaisa})`,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .where(eq(accountingVouchers.restaurantId, restaurantId))
    .groupBy(accountingVoucherLines.voucherId, accountingVouchers.voucherNumber);

  const issues = rows
    .filter((r) => Number(r.totalDebitInPaisa) !== Number(r.totalCreditInPaisa))
    .map((r) => ({
      message: `Voucher ${r.voucherNumber}: total debits (${r.totalDebitInPaisa} paisa) do not equal total credits (${r.totalCreditInPaisa} paisa).`,
    }));

  return {
    id: "voucherBalance",
    label: "Every voucher balances",
    description: "Every posted voucher's own lines must sum to debit = credit.",
    severity: severityFor(issues.length, "attention"),
    issues,
  };
}

/**
 * Not an error — a restaurant may deliberately deactivate an account it no
 * longer wants to post to while its history stays visible in period
 * reports that cover dates before it was deactivated. Surfaced as "info"
 * so an owner reviewing this screen doesn't mistake normal operation for a
 * defect, while still being able to see which accounts this applies to.
 */
async function checkDeactivatedAccountsWithActivity(restaurantId: string): Promise<HealthCheck> {
  const rows = await db
    .select({
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      lineCount: sql<string>`count(*)`,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountingVoucherLines.accountId))
    .where(and(eq(accountingVouchers.restaurantId, restaurantId), eq(chartOfAccounts.isActive, false)))
    .groupBy(chartOfAccounts.id, chartOfAccounts.code, chartOfAccounts.name);

  const issues = rows.map((r) => ({
    message: `${r.code} — ${r.name} is deactivated but has ${r.lineCount} posted line(s) in its history. This is expected if it was deactivated on purpose — reports covering periods before that still include it; it just can't accept new postings.`,
  }));

  return {
    id: "deactivatedAccountsWithActivity",
    label: "Deactivated accounts with posting history",
    description: "Lists any deactivated account that still has posted lines — informational, not necessarily a problem.",
    severity: severityFor(issues.length, "info"),
    issues,
  };
}

/**
 * AR/AP aging (Slice 5a) attributes each control-account line to a
 * customer/supplier sub-ledger; a control-account line posted without that
 * tag (e.g. a manual journal adjustment directly against Accounts
 * Receivable) still affects the control account's own balance but can
 * never appear in the aging report's party breakdown. A mismatch here is
 * "needs investigation" — it points at exactly that kind of untagged
 * posting — but per the plan's own reasoning is not automatically a
 * bookkeeping error the way an unbalanced voucher would be.
 */
async function checkArApReconciliation(restaurantId: string, timezone: string, asOfDate: string): Promise<HealthCheck> {
  const [arAging, apAging, { accounts }] = await Promise.all([
    getAccountsReceivableAging(restaurantId, timezone, asOfDate),
    getAccountsPayableAging(restaurantId, timezone, asOfDate),
    getAccountBalances({ restaurantId, toDate: asOfDate }),
  ]);

  const issues: HealthCheckIssue[] = [];
  for (const [label, aging] of [
    ["Accounts Receivable", arAging] as const,
    ["Accounts Payable", apAging] as const,
  ]) {
    if (!aging) continue; // Not mapped yet — nothing to reconcile against.
    const controlAccount = accounts.find((a) => a.accountId === aging.controlAccountId);
    const controlBalanceInPaisa = controlAccount?.balanceInPaisa ?? 0;
    if (controlBalanceInPaisa !== aging.totalOutstandingInPaisa) {
      issues.push({
        message: `${label}: the aging report's own party sub-ledger totals ${aging.totalOutstandingInPaisa} paisa outstanding, but the control account's ledger balance is ${controlBalanceInPaisa} paisa. Likely cause: a posting against this control account that isn't tagged with a customer/supplier (a manual journal entry, for example), so it never reaches the aging report's per-party breakdown.`,
      });
    }
  }

  return {
    id: "arApReconciliation",
    label: "AR/AP aging reconciles with the control accounts",
    description:
      "Compares each aging report's own total outstanding against the Accounts Receivable / Accounts Payable control account's ledger balance, as of today.",
    severity: severityFor(issues.length, "attention"),
    issues,
  };
}

/**
 * A schema-level foreign key (`ON DELETE CASCADE` from
 * accounting_voucher_lines.voucher_id to accounting_vouchers.id) should
 * already make this impossible — checking it directly is a cheap sanity
 * floor, not an expectation of finding anything, per the plan's own
 * framing of this check.
 */
async function checkOrphanedLines(restaurantId: string): Promise<HealthCheck> {
  const rows = await db
    .select({ accountCode: chartOfAccounts.code, accountName: chartOfAccounts.name })
    .from(accountingVoucherLines)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountingVoucherLines.accountId))
    .leftJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .where(and(eq(chartOfAccounts.restaurantId, restaurantId), isNull(accountingVouchers.id)));

  const issues = rows.map((r) => ({
    message: `A voucher line against ${r.accountCode} — ${r.accountName} references a voucher that no longer exists.`,
  }));

  return {
    id: "orphanedLines",
    label: "No orphaned voucher lines",
    description: "Every voucher line must reference a voucher that actually exists.",
    severity: severityFor(issues.length, "attention"),
    issues,
  };
}

export async function getAccountingHealthReport(params: {
  restaurantId: string;
  timezone: string;
}): Promise<AccountingHealthReport> {
  const asOfDate = restaurantDate(params.timezone);

  const checks = await Promise.all([
    checkBalanceConsistency(params.restaurantId),
    checkVoucherBalance(params.restaurantId),
    checkDeactivatedAccountsWithActivity(params.restaurantId),
    checkArApReconciliation(params.restaurantId, params.timezone, asOfDate),
    checkOrphanedLines(params.restaurantId),
  ]);

  const overallSeverity: HealthCheckSeverity = checks.some((c) => c.severity === "attention")
    ? "attention"
    : checks.some((c) => c.severity === "info")
      ? "info"
      : "pass";

  return {
    restaurantId: params.restaurantId,
    asOfDate,
    generatedAt: new Date().toISOString(),
    overallSeverity,
    checks,
  };
}
