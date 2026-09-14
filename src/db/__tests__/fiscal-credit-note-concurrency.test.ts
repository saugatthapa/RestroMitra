/**
 * Phase 6, Slice 6d — regression coverage for the same concurrency
 * property assignFiscalInvoiceNumber's own test file
 * (fiscal-invoice-concurrency.test.ts) already covers, applied to
 * assignFiscalCreditNoteNumber: a credit-note number must be gapless AND
 * strictly increasing per restaurant, and completely independent of the
 * fiscal INVOICE sequence (a separate table, `fiscal_credit_note_counters`
 * — see that table's own comment in schema.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("assignFiscalCreditNoteNumber concurrency (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let fiscalInvoiceLib: typeof import("@/lib/fiscal-invoice");

  let restaurantId: string;
  let branchId: string;
  let orderId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    fiscalInvoiceLib = await import("@/lib/fiscal-invoice");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-credit-note-race-${suffix}`, name: "TEST Credit Note Race Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: 100_000,
        taxInPaisa: 13_000,
        totalInPaisa: 113_000,
      })
      .returning({ id: schema.orders.id });
    orderId = order.id;
  });

  afterAll(async () => {
    await db.delete(schema.payments).where(eq(schema.payments.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db
      .delete(schema.fiscalCreditNoteCounters)
      .where(eq(schema.fiscalCreditNoteCounters.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createRefundPayment() {
    const [payment] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId, amountInPaisa: -1_000, method: "cash" })
      .returning({ id: schema.payments.id });
    return payment.id;
  }

  it("many concurrent assignments for the SAME restaurant produce a gapless, contiguous, non-duplicate set of numbers", async () => {
    const CONCURRENCY = 10;
    const paymentIds = await Promise.all(Array.from({ length: CONCURRENCY }, () => createRefundPayment()));

    const assignments = await Promise.all(
      paymentIds.map((paymentId) =>
        db.transaction((tx) => fiscalInvoiceLib.assignFiscalCreditNoteNumber(tx, { restaurantId, paymentId })),
      ),
    );

    const numbers = assignments.map((a) => a.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(CONCURRENCY);
    expect(numbers).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));

    const rows = await db
      .select({ id: schema.payments.id, fiscalCreditNoteNumber: schema.payments.fiscalCreditNoteNumber })
      .from(schema.payments)
      .where(eq(schema.payments.restaurantId, restaurantId));
    const byId = new Map(rows.map((r) => [r.id, r.fiscalCreditNoteNumber]));
    for (let i = 0; i < paymentIds.length; i++) {
      expect(byId.get(paymentIds[i])).toBe(assignments[i].number);
    }
  });

  it("is idempotent — calling it again for a payment that already has a number returns the SAME number and does not advance the counter", async () => {
    const paymentId = await createRefundPayment();

    const first = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalCreditNoteNumber(tx, { restaurantId, paymentId }),
    );
    const second = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalCreditNoteNumber(tx, { restaurantId, paymentId }),
    );

    expect(second.number).toBe(first.number);
    expect(second.assignedAt.getTime()).toBe(first.assignedAt.getTime());

    const nextPaymentId = await createRefundPayment();
    const third = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalCreditNoteNumber(tx, { restaurantId, paymentId: nextPaymentId }),
    );
    expect(third.number).toBe(first.number + 1);
  });

  it("shares no numbering with the fiscal INVOICE sequence — assigning one never advances the other's counter", async () => {
    const [creditNoteCounterBefore] = await db
      .select({ lastNumber: schema.fiscalCreditNoteCounters.lastNumber })
      .from(schema.fiscalCreditNoteCounters)
      .where(eq(schema.fiscalCreditNoteCounters.restaurantId, restaurantId));

    const invoiceOrder = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
        source: "pos",
        status: "served",
        subtotalInPaisa: 5_000,
        taxInPaisa: 0,
        totalInPaisa: 5_000,
      })
      .returning({ id: schema.orders.id });
    // This restaurant has never assigned a fiscal INVOICE number before
    // this test (only credit notes, in the tests above), so this must be
    // exactly 1 if the two sequences are truly independent counters.
    const invoiceAssignment = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalInvoiceNumber(tx, { restaurantId, orderId: invoiceOrder[0].id }),
    );
    expect(invoiceAssignment.number).toBe(1);

    const [creditNoteCounterAfterInvoice] = await db
      .select({ lastNumber: schema.fiscalCreditNoteCounters.lastNumber })
      .from(schema.fiscalCreditNoteCounters)
      .where(eq(schema.fiscalCreditNoteCounters.restaurantId, restaurantId));
    expect(creditNoteCounterAfterInvoice.lastNumber).toBe(creditNoteCounterBefore.lastNumber);

    const paymentId = await createRefundPayment();
    const creditNoteAssignment = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalCreditNoteNumber(tx, { restaurantId, paymentId }),
    );
    expect(creditNoteAssignment.number).toBe(creditNoteCounterBefore.lastNumber + 1);

    const [invoiceCounterAfter] = await db
      .select({ lastNumber: schema.fiscalInvoiceCounters.lastNumber })
      .from(schema.fiscalInvoiceCounters)
      .where(eq(schema.fiscalInvoiceCounters.restaurantId, restaurantId));
    expect(invoiceCounterAfter.lastNumber).toBe(1);
  });
});
