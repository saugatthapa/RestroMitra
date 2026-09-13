/**
 * Integration tests for Phase 4, Slice 4f —
 * src/lib/accounting/integrations/reconciliation.ts (the pulled-forward
 * minimal Bank Account, and reconciliation's mark/unmark/re-mark posting).
 * See ACCOUNTING_PHASE_4_PLAN.md Part 5 #8 and
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §9.
 *
 * Two layers, deliberately: most tests call `postReconciliationVoucher`/
 * `reverseReconciliationVoucher` directly (same convention as every other
 * Slice 4* integration test file), but ONE test goes through the real
 * `markPaymentReconciled`/`unmarkPaymentReconciled` functions with
 * automatic posting actually enabled — because this integration, unlike
 * expenses/payroll/purchases, has NO idempotency of its own if called
 * out of turn (see reconciliation.ts's own doc comment: calling
 * `postReconciliationVoucher` a second time without an unmark in between
 * would incorrectly reverse an active voucher instead of no-op'ing). It's
 * only safe because `markPaymentReconciled`/`unmarkPaymentReconciled`
 * themselves gate every call behind a CAS on `payments.reconciledAt`, so
 * that wiring is worth proving end-to-end, not just trusting by reading it.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Slice 4f: reconciliation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let reconciliationLib: typeof import("@/lib/accounting/integrations/reconciliation");
  let fr: typeof import("@/lib/financial-reconciliation");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let accountIdByCode: Map<string, string>;

  async function findAccountByCode(code: string) {
    const [row] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, code)));
    return row.id;
  }

  async function makePayment(params: { method: "card" | "mobile_wallet" | "other"; amountInPaisa: number }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-4F-${suffix}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: params.amountInPaisa,
        taxInPaisa: 0,
        totalInPaisa: params.amountInPaisa,
      })
      .returning({ id: schema.orders.id });
    const [payment] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: params.amountInPaisa, method: params.method })
      .returning();
    return payment;
  }

  async function voucherLinesFor(sourceId: string) {
    const [voucher] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceType, "payment_reconciliation"),
          eq(schema.accountingVouchers.sourceId, sourceId),
          eq(schema.accountingVouchers.postingEvent, "reconciled"),
        ),
      );
    if (!voucher) return null;
    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    return { voucher, lines };
  }

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    reconciliationLib = await import("@/lib/accounting/integrations/reconciliation");
    fr = await import("@/lib/financial-reconciliation");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-recon-${suffix}`, name: "TEST Reconciliation Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 4F", phone: `979${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    accountIdByCode = new Map();
    for (const code of ["1010", "1020", "1030", "1045"]) {
      accountIdByCode.set(code, await findAccountByCode(code));
    }
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("a card payment reconciled posts Dr Bank Account / Cr Card Clearing", async () => {
    const payment = await makePayment({ method: "card", amountInPaisa: 4000_00 });
    await db.transaction((tx) =>
      reconciliationLib.postReconciliationVoucher(tx, {
        restaurantId,
        branchId,
        paymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        method: "card",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const posted = await voucherLinesFor(payment.id);
    expect(posted).not.toBeNull();
    const bankId = accountIdByCode.get("1045")!;
    const cardClearingId = accountIdByCode.get("1010")!;
    expect(posted!.lines.find((l) => l.accountId === bankId)?.debitInPaisa).toBe(4000_00);
    expect(posted!.lines.find((l) => l.accountId === cardClearingId)?.creditInPaisa).toBe(4000_00);
  });

  it("mobile_wallet and 'other' payments route to their own clearing accounts, never the shared Bank Account's Cr side", async () => {
    const walletPayment = await makePayment({ method: "mobile_wallet", amountInPaisa: 1500_00 });
    await db.transaction((tx) =>
      reconciliationLib.postReconciliationVoucher(tx, {
        restaurantId,
        branchId,
        paymentId: walletPayment.id,
        amountInPaisa: walletPayment.amountInPaisa,
        method: "mobile_wallet",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const walletPosted = await voucherLinesFor(walletPayment.id);
    expect(walletPosted!.lines.find((l) => l.accountId === accountIdByCode.get("1020")!)?.creditInPaisa).toBe(1500_00);

    const otherPayment = await makePayment({ method: "other", amountInPaisa: 600_00 });
    await db.transaction((tx) =>
      reconciliationLib.postReconciliationVoucher(tx, {
        restaurantId,
        branchId,
        paymentId: otherPayment.id,
        amountInPaisa: otherPayment.amountInPaisa,
        method: "other",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const otherPosted = await voucherLinesFor(otherPayment.id);
    expect(otherPosted!.lines.find((l) => l.accountId === accountIdByCode.get("1030")!)?.creditInPaisa).toBe(600_00);
  });

  it("unmarking a reconciled payment fully reverses its voucher", async () => {
    const payment = await makePayment({ method: "card", amountInPaisa: 900_00 });
    await db.transaction((tx) =>
      reconciliationLib.postReconciliationVoucher(tx, {
        restaurantId,
        branchId,
        paymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        method: "card",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const original = await voucherLinesFor(payment.id);

    await db.transaction((tx) =>
      reconciliationLib.reverseReconciliationVoucher(tx, {
        restaurantId,
        paymentId: payment.id,
        reversedByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );

    const [afterVoid] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(eq(schema.accountingVouchers.id, original!.voucher.id));
    expect(afterVoid.status).toBe("reversed");

    const [reversal] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(eq(schema.accountingVouchers.reversalOfVoucherId, original!.voucher.id));
    const reversalLines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, reversal.id));

    const bankId = accountIdByCode.get("1045")!;
    const cardClearingId = accountIdByCode.get("1010")!;
    const net = (accountId: string) =>
      [...original!.lines, ...reversalLines]
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + l.debitInPaisa - l.creditInPaisa, 0);
    expect(net(bankId)).toBe(0);
    expect(net(cardClearingId)).toBe(0);
  });

  it("is a no-op for cash — structurally never reaches this module in practice, but the guard is defensive here too", async () => {
    const payment = await makePayment({ method: "card", amountInPaisa: 100_00 });
    // Force method to "cash" to exercise the defensive guard directly —
    // assertReconcilableMethod in financial-reconciliation.ts is the real
    // gate; this just proves postReconciliationVoucher never posts for it
    // either, belt-and-suspenders.
    await db.transaction((tx) =>
      reconciliationLib.postReconciliationVoucher(tx, {
        restaurantId,
        branchId,
        paymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        method: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const posted = await voucherLinesFor(payment.id);
    expect(posted).toBeNull();
  });

  it("end-to-end through the real mark/unmark/re-mark functions: the full toggle cycle nets back to the original posting", async () => {
    // Enable automatic posting for THIS restaurant only — proves the
    // isAutomaticPostingEnabled gate in financial-reconciliation.ts itself
    // actually wires up to postReconciliationVoucher/
    // reverseReconciliationVoucher, not just that the leaf functions work
    // in isolation (see this file's own top-of-file doc comment for why
    // this end-to-end layer matters more here than in prior slices).
    await db
      .update(schema.restaurants)
      .set({ automaticPostingEnabledAt: new Date() })
      .where(eq(schema.restaurants.id, restaurantId));

    const payment = await makePayment({ method: "card", amountInPaisa: 2500_00 });

    // Mark (first time) — creates the voucher fresh.
    await db.transaction((tx) =>
      fr.markPaymentReconciled(tx, {
        restaurantId,
        paymentId: payment.id,
        reconciledByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );
    const original = await voucherLinesFor(payment.id);
    expect(original).not.toBeNull();

    // Unmark — reverses it.
    await db.transaction((tx) =>
      fr.unmarkPaymentReconciled(tx, { restaurantId, paymentId: payment.id, reversedByUserId: userId, timezone: "Asia/Kathmandu" }),
    );
    const [afterUnmark] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(afterUnmark.reconciledAt).toBeNull();

    // Re-mark — restores by reversing the reversal, not by posting fresh.
    await db.transaction((tx) =>
      fr.markPaymentReconciled(tx, {
        restaurantId,
        paymentId: payment.id,
        reconciledByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );
    const [afterRemark] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(afterRemark.reconciledAt).not.toBeNull();

    // Reversal vouchers carry no sourceType/sourceId of their own (see
    // reverseVoucher's own doc comment in post-voucher.ts) — the chain must
    // be walked via reversalOfVoucherId, same as every other slice's own
    // void/un-void tests do, not queried by sourceType.
    const chain = [original!.voucher];
    let head = original!.voucher;
    for (let i = 0; i < 10; i++) {
      const [next] = await db
        .select()
        .from(schema.accountingVouchers)
        .where(eq(schema.accountingVouchers.reversalOfVoucherId, head.id));
      if (!next) break;
      chain.push(next);
      head = next;
    }
    // Original "reconciled" voucher + one reversal (unmark) + one
    // reversal-of-the-reversal (re-mark) — never a fresh fourth voucher.
    expect(chain).toHaveLength(3);

    const bankId = accountIdByCode.get("1045")!;
    const cardClearingId = accountIdByCode.get("1010")!;
    const linesAcrossChain = (
      await Promise.all(
        chain.map((v) =>
          db.select().from(schema.accountingVoucherLines).where(eq(schema.accountingVoucherLines.voucherId, v.id)),
        ),
      )
    ).flat();
    const net = (accountId: string) =>
      linesAcrossChain.filter((l) => l.accountId === accountId).reduce((s, l) => s + l.debitInPaisa - l.creditInPaisa, 0);
    expect(net(bankId)).toBe(2500_00);
    expect(net(cardClearingId)).toBe(-2500_00);
  });
});
