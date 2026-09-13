import "server-only";
import { and, eq, inArray, isNull, lte, gte, or, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import {
  accountingVouchers,
  accountingVoucherLines,
  accountingVoucherCounters,
  accountingPeriods,
  chartOfAccounts,
  type accountingVoucherTypeEnum,
} from "@/db/schema";
import { HttpError } from "@/lib/http-error";

/**
 * The single choke point every voucher — manual or automatic — is created
 * through, same convention as recordLedgerEntry (ledger.ts) and
 * recordStockMovement (inventory.ts). See ACCOUNTING_MODULE_PLAN.md and
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md for the full architecture and the
 * approved debit/credit answer for every business event this will
 * eventually post for automatically (Phase 4+) — this file only implements
 * the engine itself; nothing calls it from an operational code path yet.
 */
export class AccountingError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export type AccountingVoucherType = (typeof accountingVoucherTypeEnum.enumValues)[number];

// Type-prefixed, per the plan's "Voucher numbering" section — matches the
// pasted spec's own §6 voucher-type list. Kept here (not in schema.ts) since
// it's a display/formatting concern, not a storage one.
const VOUCHER_TYPE_PREFIXES: Record<AccountingVoucherType, string> = {
  journal: "JV",
  sales: "SV",
  purchase: "PV",
  payment: "PMV",
  expense: "EV",
  refund: "RV",
  contra: "CV",
  payroll: "PYV",
  opening_balance: "OBV",
};

export type PostVoucherLine = {
  accountId: string;
  // Exactly one of these must be a positive integer; the other must be
  // omitted/zero — mirrors the DB check constraint
  // (accounting_voucher_lines_one_sided), validated here first so a
  // mistake produces a clear message instead of a raw constraint-violation
  // error from Postgres.
  debitInPaisa?: number;
  creditInPaisa?: number;
  description?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  orderId?: string | null;
};

export type PostVoucherParams = {
  restaurantId: string;
  // Always required, even for a restaurant-wide account's own postings —
  // see the schema's own top-of-section comment for why branch tagging
  // never depends on whether the touched accounts are branch-specific.
  branchId: string;
  voucherType: AccountingVoucherType;
  lines: PostVoucherLine[];
  voucherDate?: Date | string;
  reference?: string | null;
  narration?: string | null;
  createdByUserId?: string | null;
  // Defaults to createdByUserId — Phase 1 has no separate draft/approve
  // step, so a voucher is created and posted in the same call.
  postedByUserId?: string | null;
  // Idempotency key for an automatic posting (Phase 4+) — all three or
  // none, enforced both here and by the DB's own check constraint. A
  // replay (same three values) returns the original voucher unchanged
  // instead of inserting a second one.
  sourceType?: string | null;
  sourceId?: string | null;
  postingEvent?: string | null;
  // Set only by a caller that has already verified the caller holds
  // whatever higher-trust permission gates writing into a closed period
  // (mirrors CORRECT_CASH_REGISTER's own "the route checks the permission,
  // the lib function just takes a plain flag" pattern) — postVoucher()
  // itself never checks RBAC.
  allowClosedPeriod?: boolean;
};

export type PostedVoucher = {
  id: string;
  voucherNumber: string;
  voucherType: AccountingVoucherType;
  status: string;
  voucherDate: string;
  restaurantId: string;
  branchId: string;
};

export type PostVoucherResult = {
  voucher: PostedVoucher;
  lines: Array<{
    id: string;
    accountId: string;
    debitInPaisa: number;
    creditInPaisa: number;
  }>;
  // true when this call found an existing voucher matching the
  // sourceType/sourceId/postingEvent idempotency key and returned it
  // as-is, rather than posting a new one.
  replayed: boolean;
};

function toDateOnly(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * postVoucher — validates and posts one balanced double-entry voucher.
 *
 * Enforces, in order: every line is well-formed and one-sided; the whole
 * voucher balances (sum(debit) === sum(credit)); if this is an automatic
 * posting, replays the existing voucher instead of double-posting;
 * every referenced account exists, belongs to this restaurant, and is
 * active; the accounting period covering voucherDate is open (or the
 * caller has already verified permission to bypass a closed one). Only
 * after all of that does it touch the database.
 */
export async function postVoucher(
  tx: Transaction,
  params: PostVoucherParams,
): Promise<PostVoucherResult> {
  if (!params.lines || params.lines.length < 2) {
    throw new AccountingError("A voucher needs at least two lines (one debit, one credit).");
  }

  const hasSource = params.sourceType != null || params.sourceId != null || params.postingEvent != null;
  const hasFullSource =
    params.sourceType != null && params.sourceId != null && params.postingEvent != null;
  if (hasSource && !hasFullSource) {
    throw new AccountingError(
      "sourceType, sourceId, and postingEvent must all be set together, or all left unset.",
    );
  }

  // Idempotency — check FIRST, before any validation work, so a replay of
  // an already-posted automatic voucher is cheap and never re-validates
  // (and never fails) just because, say, an account was deactivated after
  // the original posting succeeded.
  if (hasFullSource) {
    const [existing] = await tx
      .select()
      .from(accountingVouchers)
      .where(
        and(
          eq(accountingVouchers.restaurantId, params.restaurantId),
          eq(accountingVouchers.sourceType, params.sourceType!),
          eq(accountingVouchers.sourceId, params.sourceId!),
          eq(accountingVouchers.postingEvent, params.postingEvent!),
        ),
      )
      .limit(1);
    if (existing) {
      const existingLines = await tx
        .select()
        .from(accountingVoucherLines)
        .where(eq(accountingVoucherLines.voucherId, existing.id));
      return {
        voucher: {
          id: existing.id,
          voucherNumber: existing.voucherNumber,
          voucherType: existing.voucherType,
          status: existing.status,
          voucherDate: existing.voucherDate,
          restaurantId: existing.restaurantId,
          branchId: existing.branchId,
        },
        lines: existingLines.map((l) => ({
          id: l.id,
          accountId: l.accountId,
          debitInPaisa: l.debitInPaisa,
          creditInPaisa: l.creditInPaisa,
        })),
        replayed: true,
      };
    }
  }

  // Normalize + validate each line is one-sided and a positive integer.
  const normalizedLines = params.lines.map((line, i) => {
    const debit = line.debitInPaisa ?? 0;
    const credit = line.creditInPaisa ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0) {
      throw new AccountingError(`Line ${i + 1}: amounts must be non-negative whole-paisa integers.`);
    }
    const oneSided = (debit > 0 && credit === 0) || (credit > 0 && debit === 0);
    if (!oneSided) {
      throw new AccountingError(
        `Line ${i + 1}: exactly one of debit/credit must be a positive amount, not both or neither.`,
      );
    }
    return { ...line, debitInPaisa: debit, creditInPaisa: credit };
  });

  const totalDebit = normalizedLines.reduce((sum, l) => sum + l.debitInPaisa, 0);
  const totalCredit = normalizedLines.reduce((sum, l) => sum + l.creditInPaisa, 0);
  if (totalDebit !== totalCredit) {
    throw new AccountingError(
      `Voucher is not balanced: total debits (Rs. ${(totalDebit / 100).toFixed(2)}) must equal ` +
        `total credits (Rs. ${(totalCredit / 100).toFixed(2)}).`,
    );
  }
  if (totalDebit <= 0) {
    throw new AccountingError("A voucher must post a non-zero amount.");
  }

  // Every referenced account must exist, belong to this restaurant, and be
  // active. Row-locked (`for("update")`) so a concurrent request can't
  // deactivate an account between this check and the insert below.
  const accountIds = [...new Set(normalizedLines.map((l) => l.accountId))];
  const accounts = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(eq(chartOfAccounts.restaurantId, params.restaurantId), inArray(chartOfAccounts.id, accountIds)),
    )
    .for("update");
  if (accounts.length !== accountIds.length) {
    throw new AccountingError("One or more accounts were not found for this restaurant.");
  }
  const inactive = accounts.find((a) => !a.isActive);
  if (inactive) {
    throw new AccountingError(`Account "${inactive.name}" is inactive and cannot be posted to.`);
  }

  const voucherDate = toDateOnly(params.voucherDate);

  // Accounting period check — prefer a branch-specific period row over a
  // restaurant-wide one if both happen to cover this date; if NO period
  // row covers it at all, treat as open (periods are opt-in enforcement —
  // a restaurant that hasn't set any up yet isn't blocked from posting).
  const coveringPeriods = await tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.restaurantId, params.restaurantId),
        or(isNull(accountingPeriods.branchId), eq(accountingPeriods.branchId, params.branchId)),
        lte(accountingPeriods.periodStart, voucherDate),
        gte(accountingPeriods.periodEnd, voucherDate),
      ),
    );
  const period =
    coveringPeriods.find((p) => p.branchId === params.branchId) ??
    coveringPeriods.find((p) => p.branchId === null);
  if (period && period.status === "closed" && !params.allowClosedPeriod) {
    throw new AccountingError(
      `The accounting period covering ${voucherDate} is closed. Reopen it before posting into it.`,
    );
  }

  // Voucher number — atomic per-restaurant-per-type sequence, same
  // onConflictDoUpdate pattern as fiscalInvoiceCounters (see
  // assignFiscalInvoiceNumber in fiscal-invoice.ts).
  const [counter] = await tx
    .insert(accountingVoucherCounters)
    .values({ restaurantId: params.restaurantId, voucherType: params.voucherType, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [accountingVoucherCounters.restaurantId, accountingVoucherCounters.voucherType],
      set: { lastNumber: sql`${accountingVoucherCounters.lastNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ lastNumber: accountingVoucherCounters.lastNumber });
  const voucherNumber = `${VOUCHER_TYPE_PREFIXES[params.voucherType]}-${String(counter.lastNumber).padStart(6, "0")}`;

  const postedByUserId = params.postedByUserId ?? params.createdByUserId ?? null;
  const [voucher] = await tx
    .insert(accountingVouchers)
    .values({
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      voucherType: params.voucherType,
      voucherNumber,
      voucherDate,
      reference: params.reference ?? null,
      narration: params.narration ?? null,
      status: "posted",
      createdByUserId: params.createdByUserId ?? null,
      postedByUserId,
      postedAt: new Date(),
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      postingEvent: params.postingEvent ?? null,
    })
    .returning();

  const insertedLines = await tx
    .insert(accountingVoucherLines)
    .values(
      normalizedLines.map((line) => ({
        voucherId: voucher.id,
        accountId: line.accountId,
        debitInPaisa: line.debitInPaisa,
        creditInPaisa: line.creditInPaisa,
        description: line.description ?? null,
        customerId: line.customerId ?? null,
        supplierId: line.supplierId ?? null,
        orderId: line.orderId ?? null,
      })),
    )
    .returning();

  return {
    voucher: {
      id: voucher.id,
      voucherNumber: voucher.voucherNumber,
      voucherType: voucher.voucherType,
      status: voucher.status,
      voucherDate: voucher.voucherDate,
      restaurantId: voucher.restaurantId,
      branchId: voucher.branchId,
    },
    lines: insertedLines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      debitInPaisa: l.debitInPaisa,
      creditInPaisa: l.creditInPaisa,
    })),
    replayed: false,
  };
}

/**
 * Reverses an already-posted voucher: a NEW voucher with every line's
 * debit/credit swapped, referencing the original via reversalOfVoucherId.
 * The original is never edited or deleted — same "append a correction,
 * never rewrite" discipline as register_shift_corrections (cited in the
 * plan's own inspection report as the structural precedent for this).
 */
export async function reverseVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    voucherId: string;
    reason: string;
    reversedByUserId?: string | null;
    voucherDate?: Date | string;
    allowClosedPeriod?: boolean;
  },
): Promise<PostVoucherResult> {
  const [original] = await tx
    .select()
    .from(accountingVouchers)
    .where(
      and(eq(accountingVouchers.id, params.voucherId), eq(accountingVouchers.restaurantId, params.restaurantId)),
    )
    .limit(1);
  if (!original) {
    throw new AccountingError("Voucher not found.");
  }
  if (original.status === "reversed") {
    throw new AccountingError("This voucher has already been reversed.");
  }
  const originalLines = await tx
    .select()
    .from(accountingVoucherLines)
    .where(eq(accountingVoucherLines.voucherId, original.id));

  const result = await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: original.branchId,
    voucherType: original.voucherType,
    voucherDate: params.voucherDate,
    narration: `Reversal of ${original.voucherNumber}: ${params.reason}`,
    createdByUserId: params.reversedByUserId,
    allowClosedPeriod: params.allowClosedPeriod,
    lines: originalLines.map((line) => ({
      accountId: line.accountId,
      // Swapped — a line that was a debit becomes a credit of the same
      // amount, and vice versa, exactly cancelling the original.
      debitInPaisa: line.creditInPaisa > 0 ? line.creditInPaisa : undefined,
      creditInPaisa: line.debitInPaisa > 0 ? line.debitInPaisa : undefined,
      description: line.description,
      customerId: line.customerId,
      supplierId: line.supplierId,
      orderId: line.orderId,
    })),
  });

  await tx
    .update(accountingVouchers)
    .set({ status: "reversed", updatedAt: new Date() })
    .where(eq(accountingVouchers.id, original.id));
  await tx
    .update(accountingVouchers)
    .set({ reversalOfVoucherId: original.id, updatedAt: new Date() })
    .where(eq(accountingVouchers.id, result.voucher.id));

  return result;
}
