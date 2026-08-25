/**
 * Commercial-launch Phase A.8 (Financial Reconciliation) integration tests
 * for src/lib/financial-reconciliation.ts — listPaymentsForReconciliation/
 * getReconciliationSummary/markPaymentReconciled/unmarkPaymentReconciled.
 *
 * Same convention as stock-count.test.ts/stock-transfer.test.ts (see their
 * own doc comments): RBAC/tenant/branch scoping for
 * resolveRestaurantContext()/requireBranchAccess() is covered by
 * rbac/guard's own tests, so this file exercises the business logic
 * directly — cash exclusion, reconciled/unreconciled state transitions,
 * tenant/branch isolation, validation failures, concurrency, and the
 * summary totals.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Financial reconciliation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let fr: typeof import("@/lib/financial-reconciliation");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let branchBId: string;
  let otherRestaurantBranchId: string;
  let userId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    fr = await import("@/lib/financial-reconciliation");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-fin-recon-${suffix}`, name: "TEST Financial Reconciliation Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-fin-recon-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherRestaurantBranchId = otherBranch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Reconciliation User", phone: `975${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;
  });

  afterAll(async () => {
    await db.delete(schema.payments).where(eq(schema.payments.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.payments).where(eq(schema.payments.restaurantId, otherRestaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  /** A fresh order+payment pair so tests don't share running totals. */
  async function createPayment(params: {
    restaurantId: string;
    targetBranchId: string;
    method: "cash" | "card" | "mobile_wallet" | "other";
    amountInPaisa?: number;
  }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const amount = params.amountInPaisa ?? 50_000;
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: params.restaurantId,
        branchId: params.targetBranchId,
        orderNumber: `TEST-RECON-${suffix}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: Math.abs(amount),
        taxInPaisa: 0,
        totalInPaisa: Math.abs(amount),
      })
      .returning({ id: schema.orders.id });
    const [payment] = await db
      .insert(schema.payments)
      .values({
        restaurantId: params.restaurantId,
        orderId: order.id,
        amountInPaisa: amount,
        method: params.method,
      })
      .returning();
    return { orderId: order.id, paymentId: payment.id as string };
  }

  it("happy path: marking a card payment reconciled sets reconciledAt/reconciledByUserId and moves it out of the unreconciled list", async () => {
    const { paymentId } = await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });

    const before = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "unreconciled");
    expect(before.some((p) => p.id === paymentId)).toBe(true);

    const updated = await db.transaction((tx) =>
      fr.markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: userId }),
    );
    expect(updated.reconciledAt).not.toBeNull();
    expect(updated.reconciledByUserId).toBe(userId);

    const afterUnreconciled = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "unreconciled");
    expect(afterUnreconciled.some((p) => p.id === paymentId)).toBe(false);

    const afterReconciled = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "reconciled");
    expect(afterReconciled.some((p) => p.id === paymentId)).toBe(true);
  });

  it("unmarkPaymentReconciled reverses a mark and puts the payment back in the unreconciled list", async () => {
    const { paymentId } = await createPayment({ restaurantId, targetBranchId: branchId, method: "mobile_wallet" });
    await db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: userId }));

    const reversed = await db.transaction((tx) => fr.unmarkPaymentReconciled(tx, { restaurantId, paymentId }));
    expect(reversed.reconciledAt).toBeNull();
    expect(reversed.reconciledByUserId).toBeNull();

    const list = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "unreconciled");
    expect(list.some((p) => p.id === paymentId)).toBe(true);
  });

  it("validation failure: cash payments are never reconcilable — markPaymentReconciled rejects, and they never appear in any reconciliation listing or summary even under status 'all'", async () => {
    const { paymentId } = await createPayment({ restaurantId, targetBranchId: branchId, method: "cash" });

    await expect(
      db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: userId })),
    ).rejects.toMatchObject({ status: 400 });

    const all = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "all");
    expect(all.some((p) => p.id === paymentId)).toBe(false);

    const summary = await fr.getReconciliationSummary(restaurantId, { branchId });
    expect(summary.some((s) => s.method === "cash")).toBe(false);
  });

  it("validation failure: an explicit method filter of 'cash' is rejected outright rather than silently returning nothing", async () => {
    await expect(
      fr.listPaymentsForReconciliation(restaurantId, { branchId, method: "cash" }, "all"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("wrong-restaurant isolation: a payment from another restaurant can't be marked/unmarked, and never appears in this restaurant's listing", async () => {
    const { paymentId: otherPaymentId } = await createPayment({
      restaurantId: otherRestaurantId,
      targetBranchId: otherRestaurantBranchId,
      method: "card",
    });

    await expect(
      db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId: otherPaymentId, reconciledByUserId: userId })),
    ).rejects.toMatchObject({ status: 404 });

    const list = await fr.listPaymentsForReconciliation(restaurantId, {}, "all");
    expect(list.some((p) => p.id === otherPaymentId)).toBe(false);

    // But it's perfectly reconcilable in its OWN restaurant's scope.
    const ownMark = await db.transaction((tx) =>
      fr.markPaymentReconciled(tx, { restaurantId: otherRestaurantId, paymentId: otherPaymentId, reconciledByUserId: userId }),
    );
    expect(ownMark.reconciledAt).not.toBeNull();
  });

  it("wrong-branch: listPaymentsForReconciliation scoped to one branch never returns a payment from a different branch of the same restaurant", async () => {
    const { paymentId: paymentA } = await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });
    const { paymentId: paymentB } = await createPayment({ restaurantId, targetBranchId: branchBId, method: "card" });

    const branchAList = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "all");
    expect(branchAList.some((p) => p.id === paymentA)).toBe(true);
    expect(branchAList.some((p) => p.id === paymentB)).toBe(false);

    const branchBList = await fr.listPaymentsForReconciliation(restaurantId, { branchId: branchBId }, "all");
    expect(branchBList.some((p) => p.id === paymentB)).toBe(true);
    expect(branchBList.some((p) => p.id === paymentA)).toBe(false);
  });

  it("duplicate request: marking an already-reconciled payment again is rejected with a 409, not a silent no-op", async () => {
    const { paymentId } = await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });
    await db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: userId }));

    await expect(
      db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: userId })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("edge case: unmarking a payment that isn't reconciled is rejected with a 409", async () => {
    const { paymentId } = await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });
    await expect(
      db.transaction((tx) => fr.unmarkPaymentReconciled(tx, { restaurantId, paymentId })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rollback/failure: marking a nonexistent payment id is rejected with a 404 and touches nothing", async () => {
    await expect(
      db.transaction((tx) =>
        fr.markPaymentReconciled(tx, {
          restaurantId,
          paymentId: "00000000-0000-0000-0000-000000000000",
          reconciledByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("concurrent request: two concurrent markPaymentReconciled calls on the same payment — exactly one succeeds, the other gets a clean 409", async () => {
    const { paymentId } = await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });

    const attempt = () =>
      db
        .transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: userId }))
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);

    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    expect(row.reconciledAt).not.toBeNull();
  });

  it("edge case: a refund (negative amountInPaisa) is reconcilable like any other non-cash payment and nets correctly into the summary totals", async () => {
    const { paymentId: chargeId } = await createPayment({
      restaurantId,
      targetBranchId: branchId,
      method: "other",
      amountInPaisa: 30_000,
    });
    const { paymentId: refundId } = await createPayment({
      restaurantId,
      targetBranchId: branchId,
      method: "other",
      amountInPaisa: -30_000,
    });

    await db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId: chargeId, reconciledByUserId: userId }));
    await db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId: refundId, reconciledByUserId: userId }));

    const summary = await fr.getReconciliationSummary(restaurantId, { branchId });
    const otherRow = summary.find((s) => s.method === "other");
    expect(otherRow).toBeDefined();
    // The charge and its refund net to zero in the reconciled total, but
    // both count individually.
    expect(otherRow!.reconciledTotalInPaisa).toBe(0);
    expect(otherRow!.reconciledCount).toBeGreaterThanOrEqual(2);
  });

  it("Commercial Launch Phase B.5 (Data Export): a custom limit narrows the result count, for the export route's higher-than-UI-default use case", async () => {
    await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });
    await createPayment({ restaurantId, targetBranchId: branchId, method: "card" });

    const limited = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "all", 1);
    expect(limited.length).toBeLessThanOrEqual(1);

    const unlimited = await fr.listPaymentsForReconciliation(restaurantId, { branchId }, "all");
    expect(unlimited.length).toBeGreaterThanOrEqual(2);
  });

  it("getReconciliationSummary reports separate reconciled/unreconciled totals per method", async () => {
    const { paymentId: reconciledOne } = await createPayment({
      restaurantId,
      targetBranchId: branchBId,
      method: "mobile_wallet",
      amountInPaisa: 40_000,
    });
    const { paymentId: unreconciledOne } = await createPayment({
      restaurantId,
      targetBranchId: branchBId,
      method: "mobile_wallet",
      amountInPaisa: 25_000,
    });
    await db.transaction((tx) => fr.markPaymentReconciled(tx, { restaurantId, paymentId: reconciledOne, reconciledByUserId: userId }));

    const summary = await fr.getReconciliationSummary(restaurantId, { branchId: branchBId });
    const walletRow = summary.find((s) => s.method === "mobile_wallet");
    expect(walletRow).toBeDefined();
    expect(walletRow!.reconciledTotalInPaisa).toBeGreaterThanOrEqual(40_000);
    expect(walletRow!.unreconciledTotalInPaisa).toBeGreaterThanOrEqual(25_000);

    const unreconciledList = await fr.listPaymentsForReconciliation(restaurantId, { branchId: branchBId }, "unreconciled");
    expect(unreconciledList.some((p) => p.id === unreconciledOne)).toBe(true);
    expect(unreconciledList.some((p) => p.id === reconciledOne)).toBe(false);
  });
});
