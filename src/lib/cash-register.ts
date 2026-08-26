import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import {
  registerShifts,
  registerCashMovements,
  registerShiftCorrections,
  orders,
  payments,
  expenses,
} from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { isUniqueViolation } from "@/lib/db-error";
import { restaurantDate } from "@/lib/restaurant-date";
import { assertBusinessDayWritable } from "@/lib/daily-closing";

export class CashRegisterError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export type RegisterCashMovementType = "addition" | "drop" | "payout";

/**
 * The one place the "expected cash" formula lives — see the block comment
 * above `registerShifts` in schema.ts for the full derivation:
 *
 *   opening cash + net cash sales/refunds - cash expenses
 *   + cash additions - cash drops - cash payouts
 *
 * Every term is read from data that already exists elsewhere (payments,
 * expenses, this shift's own cash movements); nothing is duplicated or
 * ever trusted from the client.
 *
 * `asOf` is an exclusive upper bound: pass `new Date()` for a live
 * in-progress shift, or the exact close timestamp when freezing the
 * snapshot at close time.
 */
export async function computeExpectedCashInPaisa(
  tx: Transaction,
  params: {
    shiftId: string;
    branchId: string;
    openingCashInPaisa: number;
    openedAt: Date;
    asOf: Date;
  },
): Promise<number> {
  const { shiftId, branchId, openingCashInPaisa, openedAt, asOf } = params;

  // Net cash sales/refunds — payments.amountInPaisa is already signed
  // (positive = payment, negative = refund), so one SUM nets both.
  const [cashPaymentsRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${payments.amountInPaisa}), 0)` })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(
      and(
        eq(orders.branchId, branchId),
        eq(payments.method, "cash"),
        gte(payments.createdAt, openedAt),
        lt(payments.createdAt, asOf),
      ),
    );
  const netCashSalesInPaisa = Number(cashPaymentsRow?.total ?? 0);

  // Cash expenses paid out of this branch's till during the shift. Voided
  // expenses never actually paid out, so they're excluded regardless of
  // status/paidAt.
  const [cashExpensesRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)` })
    .from(expenses)
    .where(
      and(
        eq(expenses.branchId, branchId),
        eq(expenses.paymentMethod, "cash"),
        eq(expenses.status, "paid"),
        eq(expenses.isVoided, false),
        gte(expenses.paidAt, openedAt),
        lt(expenses.paidAt, asOf),
      ),
    );
  const cashExpensesInPaisa = Number(cashExpensesRow?.total ?? 0);

  // This shift's own manual cash movements, grouped by type.
  const movementRows = await tx
    .select({
      type: registerCashMovements.type,
      total: sql<string>`coalesce(sum(${registerCashMovements.amountInPaisa}), 0)`,
    })
    .from(registerCashMovements)
    .where(and(eq(registerCashMovements.shiftId, shiftId), lt(registerCashMovements.createdAt, asOf)))
    .groupBy(registerCashMovements.type);

  let additionsInPaisa = 0;
  let dropsInPaisa = 0;
  let payoutsInPaisa = 0;
  for (const row of movementRows) {
    const amount = Number(row.total);
    if (row.type === "addition") additionsInPaisa = amount;
    else if (row.type === "drop") dropsInPaisa = amount;
    else if (row.type === "payout") payoutsInPaisa = amount;
  }

  return (
    openingCashInPaisa +
    netCashSalesInPaisa -
    cashExpensesInPaisa +
    additionsInPaisa -
    dropsInPaisa -
    payoutsInPaisa
  );
}

/**
 * Opens a new register shift. Relies on two partial unique indexes to
 * enforce concurrency safety at the database level rather than a
 * check-then-insert race in application code (same reasoning as every
 * other "at most one X" invariant in this codebase — see e.g.
 * user_roles_one_active_per_restaurant_unique):
 *   - register_shifts_one_open_per_cashier: this user can't already have
 *     an open shift anywhere.
 *   - register_shifts_one_open_per_branch_register: this branch/register
 *     combination can't already have an open shift.
 * A concurrent double-open attempt has exactly one winner; the loser gets
 * a unique-violation (Postgres error 23505), translated here into a clear
 * 409 rather than a raw DB error leaking to the route.
 */
export async function openRegisterShift(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    registerName: string;
    openedByUserId: string;
    openingCashInPaisa: number;
    openingNotes?: string | null;
  },
) {
  if (!Number.isInteger(params.openingCashInPaisa) || params.openingCashInPaisa < 0) {
    throw new CashRegisterError("Opening cash must be a non-negative whole-paisa amount.");
  }

  try {
    const [shift] = await tx
      .insert(registerShifts)
      .values({
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        registerName: params.registerName,
        openedByUserId: params.openedByUserId,
        openingCashInPaisa: params.openingCashInPaisa,
        openingNotes: params.openingNotes ?? null,
      })
      .returning();
    return shift;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CashRegisterError(
        "There is already an open register shift for you, or for this branch/register. Close it before opening a new one.",
        409,
      );
    }
    throw err;
  }
}

/** Records a manual cash movement (addition/drop/payout) against an OPEN shift. */
export async function recordCashMovement(
  tx: Transaction,
  params: {
    shiftId: string;
    type: RegisterCashMovementType;
    amountInPaisa: number;
    reason?: string | null;
    recordedByUserId: string;
    timezone: string;
    role?: string;
  },
) {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new CashRegisterError("A cash movement must have a positive whole-paisa amount.");
  }

  // Row-lock the shift so a close racing a movement can't interleave: the
  // movement either commits before close reads it, or close's own FOR
  // UPDATE blocks until this transaction finishes.
  const [shift] = await tx
    .select()
    .from(registerShifts)
    .where(eq(registerShifts.id, params.shiftId))
    .for("update");

  if (!shift) {
    throw new CashRegisterError("Register shift not found.", 404);
  }
  if (shift.status !== "open") {
    throw new CashRegisterError("This register shift is already closed.", 409);
  }

  // QA hardening pass (Phase 5 / centralized daily-close lock) — a cash
  // drop/addition/payout changes what closeRegisterShift will later
  // compute as expectedCashInPaisa for whatever day it lands on; same lock
  // as every other financial mutation. Always "now" — a movement is
  // recorded at the moment it happens, mid-shift.
  await assertBusinessDayWritable(
    {
      userId: params.recordedByUserId,
      restaurantId: shift.restaurantId,
      branchId: shift.branchId,
      businessDate: restaurantDate(params.timezone),
      role: params.role,
    },
    tx,
  );

  const [movement] = await tx
    .insert(registerCashMovements)
    .values({
      shiftId: params.shiftId,
      type: params.type,
      amountInPaisa: params.amountInPaisa,
      reason: params.reason ?? null,
      recordedByUserId: params.recordedByUserId,
    })
    .returning();
  return movement;
}

/**
 * Closes an open shift: freezes expectedCashInPaisa (computed as of the
 * close moment) and the actual/variance the caller counted, via a
 * compare-and-swap on status (same pattern as reservation-status,
 * attendance clock-out) so two concurrent close attempts can't both
 * "win" and silently overwrite each other's numbers.
 */
export async function closeRegisterShift(
  tx: Transaction,
  params: {
    shiftId: string;
    actualCashInPaisa: number;
    closingNotes?: string | null;
    closedByUserId: string;
    timezone: string;
    role?: string;
  },
) {
  if (!Number.isInteger(params.actualCashInPaisa) || params.actualCashInPaisa < 0) {
    throw new CashRegisterError("Actual cash must be a non-negative whole-paisa amount.");
  }

  const [shift] = await tx
    .select()
    .from(registerShifts)
    .where(eq(registerShifts.id, params.shiftId))
    .for("update");

  if (!shift) {
    throw new CashRegisterError("Register shift not found.", 404);
  }
  if (shift.status !== "open") {
    throw new CashRegisterError("This register shift is already closed.", 409);
  }

  // QA hardening pass (Phase 5 / centralized daily-close lock) — closing a
  // shift is what FREEZES expectedCashInPaisa/varianceInPaisa, the exact
  // numbers getRegisterSummaryForDay reads straight into the Daily Closing
  // snapshot. Keyed off "now" (the close moment), matching
  // getRegisterSummaryForDay's own bucketing of a shift by its closedAt
  // timestamp — see daily-closing.ts.
  await assertBusinessDayWritable(
    {
      userId: params.closedByUserId,
      restaurantId: shift.restaurantId,
      branchId: shift.branchId,
      businessDate: restaurantDate(params.timezone),
      role: params.role,
    },
    tx,
  );

  const closedAt = new Date();
  const expectedCashInPaisa = await computeExpectedCashInPaisa(tx, {
    shiftId: shift.id,
    branchId: shift.branchId,
    openingCashInPaisa: shift.openingCashInPaisa,
    openedAt: shift.openedAt,
    asOf: closedAt,
  });
  const varianceInPaisa = params.actualCashInPaisa - expectedCashInPaisa;

  const [updated] = await tx
    .update(registerShifts)
    .set({
      status: "closed",
      closedByUserId: params.closedByUserId,
      closedAt,
      actualCashInPaisa: params.actualCashInPaisa,
      expectedCashInPaisa,
      varianceInPaisa,
      closingNotes: params.closingNotes ?? null,
      updatedAt: closedAt,
    })
    .where(and(eq(registerShifts.id, params.shiftId), eq(registerShifts.status, "open")))
    .returning();

  if (!updated) {
    // Someone else closed it between our SELECT ... FOR UPDATE and this
    // UPDATE — shouldn't happen given the row lock above, but fail safe
    // rather than silently proceed with a stale row.
    throw new CashRegisterError("This register shift was just closed by someone else.", 409);
  }
  return updated;
}

/**
 * Corrects a closed shift's actual cash/variance. Never overwrites
 * history silently: appends a `register_shift_corrections` row recording
 * exactly what changed and why, then updates the shift to the corrected
 * values. The shift's `expectedCashInPaisa` (and the underlying sales/
 * expense data it was computed from) is untouched — only what the
 * counted actual cash and resulting variance are believed to be can be
 * corrected, matching "preserve the original transaction, create a
 * correction rather than silently rewrite history."
 */
export async function correctRegisterShift(
  tx: Transaction,
  params: {
    shiftId: string;
    newActualCashInPaisa: number;
    reason: string;
    correctedByUserId: string;
  },
) {
  if (!Number.isInteger(params.newActualCashInPaisa) || params.newActualCashInPaisa < 0) {
    throw new CashRegisterError("Actual cash must be a non-negative whole-paisa amount.");
  }
  if (!params.reason.trim()) {
    throw new CashRegisterError("A reason is required to correct a closed register shift.");
  }

  const [shift] = await tx
    .select()
    .from(registerShifts)
    .where(eq(registerShifts.id, params.shiftId))
    .for("update");

  if (!shift) {
    throw new CashRegisterError("Register shift not found.", 404);
  }
  if (shift.status !== "closed") {
    throw new CashRegisterError("Only a closed register shift can be corrected.", 409);
  }
  if (shift.expectedCashInPaisa === null) {
    // Guarded by the closed_fields_consistent CHECK constraint — a closed
    // shift always has this set — but keep TypeScript honest.
    throw new CashRegisterError("This shift is missing its expected-cash snapshot.", 500);
  }

  const newVarianceInPaisa = params.newActualCashInPaisa - shift.expectedCashInPaisa;

  const [correction] = await tx
    .insert(registerShiftCorrections)
    .values({
      shiftId: shift.id,
      correctedByUserId: params.correctedByUserId,
      previousActualCashInPaisa: shift.actualCashInPaisa!,
      newActualCashInPaisa: params.newActualCashInPaisa,
      previousVarianceInPaisa: shift.varianceInPaisa!,
      newVarianceInPaisa,
      reason: params.reason.trim(),
    })
    .returning();

  const [updated] = await tx
    .update(registerShifts)
    .set({
      actualCashInPaisa: params.newActualCashInPaisa,
      varianceInPaisa: newVarianceInPaisa,
      updatedAt: new Date(),
    })
    .where(and(eq(registerShifts.id, params.shiftId), eq(registerShifts.status, "closed")))
    .returning();

  if (!updated) {
    throw new CashRegisterError("This register shift changed unexpectedly. Please retry.", 409);
  }

  return { shift: updated, correction };
}
