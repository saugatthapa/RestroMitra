import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { loans, loanPayments, chartOfAccounts, branches } from "@/db/schema";
import { postVoucher, AccountingError, type PostedVoucher } from "./post-voucher";
import { resolveAccountMappings } from "./account-mappings";
import { MAPPING_KEYS } from "./account-mapping-keys";
import { resolveBankAccountForPosting } from "./bank-accounts";

/**
 * Phase 5, Slice 5e — Loan accounting. Per sign-off (AskUserQuestion,
 * "Recommended"): manual principal/interest split entry on every repayment
 * — there is no amortization-schedule calculator anywhere in this module.
 * interestRateBasisPoints and termMonths (see schema.ts) are purely
 * informational display data, never used to compute a split.
 *
 * Same "wraps its own chart_of_accounts child row" pattern Slice 5b/5d
 * already established for bank accounts and fixed assets: each loan gets
 * its own child account under the seeded "2400 Loans Payable", coded in
 * the reserved 2401-2499 block.
 */

const LOAN_PARENT_CODE = "2400";
const LOAN_CODE_BLOCK_START = 2401;
const LOAN_CODE_BLOCK_END = 2499;
const INTEREST_EXPENSE_CODE = "5160";

export type LoanFundingMethod = "cash" | "bank";
export type LoanStatus = "active" | "closed";

export type LoanRow = {
  id: string;
  chartOfAccountsId: string;
  lenderName: string;
  principalInPaisa: number;
  interestRateBasisPoints: number | null;
  startDate: string;
  termMonths: number | null;
  outstandingPrincipalInPaisa: number;
  status: LoanStatus;
  closedAt: Date | null;
  notes: string | null;
  code: string;
  accountName: string;
  isActive: boolean;
  createdAt: Date;
};

async function findAccountByCode(
  tx: Transaction,
  restaurantId: string,
  code: string,
  label: string,
): Promise<{ id: string }> {
  const [row] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.restaurantId, restaurantId), eq(chartOfAccounts.code, code)))
    .limit(1);
  if (!row) {
    throw new AccountingError(
      `This restaurant's chart of accounts hasn't been set up yet — seed it from the Overview tab before ${label}.`,
    );
  }
  return row;
}

/**
 * Every caller of this module posts a restaurant-wide voucher (a loan has
 * no branch of its own) — same "default to the main branch" convention
 * fixed-assets.ts's own resolveMainBranchId already uses (duplicated here
 * rather than imported, matching this codebase's existing per-module
 * self-containment convention).
 */
export async function resolveMainBranchId(tx: Transaction, restaurantId: string): Promise<string> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isMain, true)))
    .limit(1);
  if (!row) {
    throw new AccountingError("This restaurant has no main branch configured.");
  }
  return row.id;
}

function toLoanRow(row: {
  id: string;
  chartOfAccountsId: string;
  lenderName: string;
  principalInPaisa: number;
  interestRateBasisPoints: number | null;
  startDate: string;
  termMonths: number | null;
  outstandingPrincipalInPaisa: number;
  status: LoanStatus;
  closedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  code: string;
  accountName: string;
  isActive: boolean;
}): LoanRow {
  return {
    id: row.id,
    chartOfAccountsId: row.chartOfAccountsId,
    lenderName: row.lenderName,
    principalInPaisa: row.principalInPaisa,
    interestRateBasisPoints: row.interestRateBasisPoints,
    startDate: row.startDate,
    termMonths: row.termMonths,
    outstandingPrincipalInPaisa: row.outstandingPrincipalInPaisa,
    status: row.status,
    closedAt: row.closedAt,
    notes: row.notes,
    code: row.code,
    accountName: row.accountName,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

/** Lists every loan (active and closed alike — the UI decides how to show a closed one), newest first. */
export async function listLoans(tx: Transaction, restaurantId: string): Promise<LoanRow[]> {
  const rows = await tx
    .select({
      id: loans.id,
      chartOfAccountsId: loans.chartOfAccountsId,
      lenderName: loans.lenderName,
      principalInPaisa: loans.principalInPaisa,
      interestRateBasisPoints: loans.interestRateBasisPoints,
      startDate: loans.startDate,
      termMonths: loans.termMonths,
      outstandingPrincipalInPaisa: loans.outstandingPrincipalInPaisa,
      status: loans.status,
      closedAt: loans.closedAt,
      notes: loans.notes,
      createdAt: loans.createdAt,
      code: chartOfAccounts.code,
      accountName: chartOfAccounts.name,
      isActive: chartOfAccounts.isActive,
    })
    .from(loans)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, loans.chartOfAccountsId))
    .where(eq(loans.restaurantId, restaurantId))
    .orderBy(loans.startDate);
  return rows.map(toLoanRow).reverse();
}

export type LoanPaymentRow = {
  id: string;
  loanId: string;
  voucherId: string;
  paymentDate: string;
  principalInPaisa: number;
  interestInPaisa: number;
  notes: string | null;
  createdAt: Date;
};

/** One loan's own repayment history, oldest first — the audit trail behind its running outstanding balance. */
export async function listLoanPayments(
  tx: Transaction,
  params: { restaurantId: string; loanId: string },
): Promise<LoanPaymentRow[]> {
  const rows = await tx
    .select()
    .from(loanPayments)
    .where(and(eq(loanPayments.restaurantId, params.restaurantId), eq(loanPayments.loanId, params.loanId)))
    .orderBy(loanPayments.paymentDate);
  return rows;
}

/**
 * Resolves the cash/bank account on the other side of a loan event.
 * Deliberately uses a different legacy fallback mapping key depending on
 * direction of money flow (only matters for a restaurant with zero real
 * Slice 5b bank accounts yet): BANK_ACCOUNT ("money confirmed in the bank")
 * for a receipt (money coming IN), BANK_DIGITAL_PAYMENTS ("outgoing
 * clearing bucket") for a repayment (money going OUT) — matching the
 * semantic framing each key's own doc comment already describes.
 */
async function resolveCashOrBankAccount(
  tx: Transaction,
  params: { restaurantId: string; method: LoanFundingMethod; bankAccountId?: string | null; direction: "in" | "out" },
): Promise<string> {
  if (params.method === "bank") {
    return resolveBankAccountForPosting(tx, {
      restaurantId: params.restaurantId,
      requestedBankAccountId: params.bankAccountId,
      legacyMappingKey: params.direction === "in" ? MAPPING_KEYS.BANK_ACCOUNT : MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
    });
  }
  const resolved = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys: [MAPPING_KEYS.PAYMENT_METHOD_CASH],
  });
  return resolved.get(MAPPING_KEYS.PAYMENT_METHOD_CASH)!;
}

/**
 * Records a new loan and posts its receipt voucher in the same
 * transaction: Dr the funding destination (cash or a real bank account) /
 * Cr the loan's own auto-provisioned Payable account (its full principal).
 */
export async function recordLoanReceipt(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    lenderName: string;
    principalInPaisa: number;
    interestRateBasisPoints?: number | null;
    startDate: string;
    termMonths?: number | null;
    fundingMethod: LoanFundingMethod;
    bankAccountId?: string | null;
    notes?: string | null;
    createdByUserId: string;
  },
): Promise<{ loan: LoanRow; voucher: PostedVoucher }> {
  if (!Number.isInteger(params.principalInPaisa) || params.principalInPaisa <= 0) {
    throw new AccountingError("Principal must be a positive amount.");
  }
  if (
    params.interestRateBasisPoints != null &&
    (!Number.isInteger(params.interestRateBasisPoints) || params.interestRateBasisPoints < 0)
  ) {
    throw new AccountingError("Interest rate must be a non-negative number of basis points.");
  }
  if (params.termMonths != null && (!Number.isInteger(params.termMonths) || params.termMonths <= 0)) {
    throw new AccountingError("Term must be a positive number of months.");
  }

  const parent = await findAccountByCode(tx, params.restaurantId, LOAN_PARENT_CODE, "recording a loan");

  const [{ maxCode }] = await tx
    .select({ maxCode: sql<string | null>`max(${chartOfAccounts.code})` })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.restaurantId, params.restaurantId),
        sql`${chartOfAccounts.code} ~ '^[0-9]+$'`,
        sql`${chartOfAccounts.code}::int >= ${LOAN_CODE_BLOCK_START}`,
        sql`${chartOfAccounts.code}::int <= ${LOAN_CODE_BLOCK_END}`,
      ),
    );
  const nextCode = maxCode ? parseInt(maxCode, 10) + 1 : LOAN_CODE_BLOCK_START;
  if (nextCode > LOAN_CODE_BLOCK_END) {
    throw new AccountingError("This restaurant has reached the maximum number of loans supported.");
  }

  const [account] = await tx
    .insert(chartOfAccounts)
    .values({
      restaurantId: params.restaurantId,
      code: String(nextCode),
      name: `Loan — ${params.lenderName}`,
      type: "liability",
      normalBalance: "credit",
      parentAccountId: parent.id,
      isSystemAccount: false,
    })
    .returning({ id: chartOfAccounts.id, code: chartOfAccounts.code, name: chartOfAccounts.name });

  const [loan] = await tx
    .insert(loans)
    .values({
      restaurantId: params.restaurantId,
      chartOfAccountsId: account.id,
      lenderName: params.lenderName,
      principalInPaisa: params.principalInPaisa,
      interestRateBasisPoints: params.interestRateBasisPoints ?? null,
      startDate: params.startDate,
      termMonths: params.termMonths ?? null,
      outstandingPrincipalInPaisa: params.principalInPaisa,
      notes: params.notes || null,
      createdByUserId: params.createdByUserId,
    })
    .returning();

  const fundingAccountId = await resolveCashOrBankAccount(tx, {
    restaurantId: params.restaurantId,
    method: params.fundingMethod,
    bankAccountId: params.bankAccountId,
    direction: "in",
  });

  const { voucher } = await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "loan",
    voucherDate: params.startDate,
    narration: `Loan received — ${params.lenderName}`,
    createdByUserId: params.createdByUserId,
    sourceType: "loan_receipt",
    sourceId: loan.id,
    postingEvent: "received",
    lines: [
      { accountId: fundingAccountId, debitInPaisa: params.principalInPaisa, description: params.lenderName },
      { accountId: account.id, creditInPaisa: params.principalInPaisa, description: params.lenderName },
    ],
  });

  return {
    loan: toLoanRow({ ...loan, code: account.code, accountName: account.name, isActive: true }),
    voucher,
  };
}

/**
 * Records one repayment instalment against a loan — per sign-off, the
 * principal/interest split is always entered manually, never computed from
 * the loan's own informational interestRateBasisPoints. Posts:
 *
 *   Dr the loan's own Payable account   [principal portion, if any]
 *   Dr Interest Expense                 [interest portion, if any]
 *       Cr Cash / Bank Account              [principal + interest]
 *
 * Deliberately does NOT use postVoucher's sourceType/sourceId idempotency
 * (same reasoning as runDepreciation in fixed-assets.ts): a loan can have
 * many repayments and there is no natural one-time key available before
 * the voucher exists, so a naive reuse of a single sourceId would replay a
 * stale voucher on a second legitimate call instead of posting fresh data.
 */
export async function recordLoanRepayment(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    loanId: string;
    paymentDate: string;
    principalInPaisa: number;
    interestInPaisa: number;
    paymentMethod: LoanFundingMethod;
    bankAccountId?: string | null;
    notes?: string | null;
    createdByUserId: string;
  },
): Promise<{ loan: LoanRow; voucher: PostedVoucher }> {
  const [loan] = await tx
    .select()
    .from(loans)
    .where(and(eq(loans.id, params.loanId), eq(loans.restaurantId, params.restaurantId)))
    .limit(1);
  if (!loan) {
    throw new AccountingError("Loan not found.");
  }
  if (loan.status === "closed") {
    throw new AccountingError("This loan is already closed.");
  }
  if (
    !Number.isInteger(params.principalInPaisa) ||
    !Number.isInteger(params.interestInPaisa) ||
    params.principalInPaisa < 0 ||
    params.interestInPaisa < 0
  ) {
    throw new AccountingError("Principal and interest must be non-negative amounts.");
  }
  if (params.principalInPaisa === 0 && params.interestInPaisa === 0) {
    throw new AccountingError("Enter a principal or interest amount.");
  }
  if (params.principalInPaisa > loan.outstandingPrincipalInPaisa) {
    throw new AccountingError("Principal can't exceed the loan's outstanding balance.");
  }

  const clearingAccountId = await resolveCashOrBankAccount(tx, {
    restaurantId: params.restaurantId,
    method: params.paymentMethod,
    bankAccountId: params.bankAccountId,
    direction: "out",
  });

  const lines: Array<{ accountId: string; debitInPaisa?: number; creditInPaisa?: number; description?: string }> = [];
  if (params.principalInPaisa > 0) {
    lines.push({
      accountId: loan.chartOfAccountsId,
      debitInPaisa: params.principalInPaisa,
      description: loan.lenderName,
    });
  }
  if (params.interestInPaisa > 0) {
    const interestExpenseAccount = await findAccountByCode(
      tx,
      params.restaurantId,
      INTEREST_EXPENSE_CODE,
      "recording a loan repayment",
    );
    lines.push({
      accountId: interestExpenseAccount.id,
      debitInPaisa: params.interestInPaisa,
      description: loan.lenderName,
    });
  }
  lines.push({
    accountId: clearingAccountId,
    creditInPaisa: params.principalInPaisa + params.interestInPaisa,
    description: loan.lenderName,
  });

  const { voucher } = await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "loan",
    voucherDate: params.paymentDate,
    narration: `Loan repayment — ${loan.lenderName}`,
    createdByUserId: params.createdByUserId,
    lines,
  });

  await tx.insert(loanPayments).values({
    restaurantId: params.restaurantId,
    loanId: loan.id,
    voucherId: voucher.id,
    paymentDate: params.paymentDate,
    principalInPaisa: params.principalInPaisa,
    interestInPaisa: params.interestInPaisa,
    notes: params.notes || null,
    createdByUserId: params.createdByUserId,
  });

  const newOutstanding = loan.outstandingPrincipalInPaisa - params.principalInPaisa;
  const [updated] = await tx
    .update(loans)
    .set({
      outstandingPrincipalInPaisa: newOutstanding,
      status: newOutstanding === 0 ? "closed" : "active",
      closedAt: newOutstanding === 0 ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(loans.id, loan.id))
    .returning();

  const [account] = await tx
    .select({ code: chartOfAccounts.code, name: chartOfAccounts.name, isActive: chartOfAccounts.isActive })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.id, loan.chartOfAccountsId))
    .limit(1);

  return {
    loan: toLoanRow({ ...updated, code: account.code, accountName: account.name, isActive: account.isActive }),
    voucher,
  };
}
