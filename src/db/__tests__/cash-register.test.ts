/**
 * Commercial-launch Phase A.1 regression tests for src/lib/cash-register.ts
 * — the module every register-shift route (open/close/cash-movements/
 * correct) delegates its actual logic to.
 *
 * Same convention as every other DB-backed integration test in this
 * project: the routes themselves resolve session/permissions via
 * resolveRestaurantContext()/requireBranchAccess(), which read an httpOnly
 * cookie through next/headers' cookies() and have no mocking harness here
 * (see reservation-status-cas.test.ts's own doc comment for the established
 * precedent) — RBAC/tenant/branch scoping for THOSE primitives is already
 * covered by rbac/guard's own tests, so this file exercises the actual
 * cash-register business logic directly: concurrency (CAS + unique
 * indexes), the expected-cash formula, and the correction audit trail.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Cash register shifts (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let cashRegister: typeof import("@/lib/cash-register");

  let restaurantId: string;
  let branchId: string;
  let branchBId: string;
  let cashierAId: string;
  let cashierBId: string;
  let expenseCategoryId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    cashRegister = await import("@/lib/cash-register");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cash-register-${suffix}`, name: "TEST Cash Register Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Second", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [cashierA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cashier A", phone: `971${suffix}1`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    cashierAId = cashierA.id;

    const [cashierB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cashier B", phone: `971${suffix}2`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    cashierBId = cashierB.id;

    const [expenseCategory] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId, name: "TEST Register Supplies" })
      .returning({ id: schema.expenseCategories.id });
    expenseCategoryId = expenseCategory.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function makeOrder(placedAt: Date) {
    const { generateOrderNumber } = await import("@/lib/orders");
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: generateOrderNumber("UTC"),
        source: "pos",
        status: "completed",
        subtotalInPaisa: 20_000,
        taxInPaisa: 0,
        totalInPaisa: 20_000,
        placedAt,
      })
      .returning({ id: schema.orders.id });
    return order.id;
  }

  async function makePayment(orderId: string, amountInPaisa: number, method: "cash" | "card", createdAt: Date) {
    await db.insert(schema.payments).values({ restaurantId, orderId, amountInPaisa, method, createdAt });
  }

  async function makeCashExpense(amountInPaisa: number, paidAt: Date) {
    await db.insert(schema.expenses).values({
      restaurantId,
      branchId,
      categoryId: expenseCategoryId,
      amountInPaisa,
      description: "TEST cash expense",
      status: "paid",
      paymentMethod: "cash",
      paidAt,
    });
  }

  describe("openRegisterShift", () => {
    it("opens a shift with the given opening cash and status open", async () => {
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Happy Path",
          openedByUserId: cashierAId,
          openingCashInPaisa: 5_000,
          openingNotes: "Starting float",
        }),
      );
      expect(shift.status).toBe("open");
      expect(shift.openingCashInPaisa).toBe(5_000);
      expect(shift.closedAt).toBeNull();

      // Cleanup so later tests in this file aren't blocked by the
      // one-open-shift-per-cashier unique index.
      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, {
          shiftId: shift.id,
          actualCashInPaisa: 5_000,
          closedByUserId: cashierAId, timezone: "Asia/Kathmandu",
        }),
      );
    });

    it("rejects opening a second shift for the same cashier while one is already open (concurrency)", async () => {
      const first = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Same Cashier 1",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );

      const results = await Promise.allSettled([
        db.transaction((tx) =>
          cashRegister.openRegisterShift(tx, {
            restaurantId,
            branchId: branchBId,
            registerName: "TEST Register Same Cashier 2",
            openedByUserId: cashierAId,
            openingCashInPaisa: 1_000,
          }),
        ),
      ]);
      expect(results[0].status).toBe("rejected");
      expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(cashRegister.CashRegisterError);

      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, {
          shiftId: first.id,
          actualCashInPaisa: 1_000,
          closedByUserId: cashierAId, timezone: "Asia/Kathmandu",
        }),
      );
    });

    it("rejects opening a second concurrent shift for the same branch/register, but allows a different register name", async () => {
      const first = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Shared Counter",
          openedByUserId: cashierAId,
          openingCashInPaisa: 2_000,
        }),
      );

      // Same branch, same register name, different cashier -> rejected.
      await expect(
        db.transaction((tx) =>
          cashRegister.openRegisterShift(tx, {
            restaurantId,
            branchId,
            registerName: "TEST Register Shared Counter",
            openedByUserId: cashierBId,
            openingCashInPaisa: 2_000,
          }),
        ),
      ).rejects.toBeInstanceOf(cashRegister.CashRegisterError);

      // Same branch, DIFFERENT register name, different cashier -> allowed.
      const second = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Second Counter",
          openedByUserId: cashierBId,
          openingCashInPaisa: 2_000,
        }),
      );
      expect(second.status).toBe("open");

      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, { shiftId: first.id, actualCashInPaisa: 2_000, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
      );
      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, { shiftId: second.id, actualCashInPaisa: 2_000, closedByUserId: cashierBId, timezone: "Asia/Kathmandu", }),
      );
    });

    it("rejects a negative opening cash amount", async () => {
      await expect(
        db.transaction((tx) =>
          cashRegister.openRegisterShift(tx, {
            restaurantId,
            branchId,
            registerName: "TEST Register Negative",
            openedByUserId: cashierAId,
            openingCashInPaisa: -100,
          }),
        ),
      ).rejects.toBeInstanceOf(cashRegister.CashRegisterError);
    });
  });

  describe("expected cash computation + close", () => {
    it("computes expected cash as opening + net cash sales - cash expenses + additions - drops - payouts", async () => {
      const openedAt = new Date("2024-01-01T08:00:00Z");
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Formula",
          openedByUserId: cashierAId,
          openingCashInPaisa: 10_000,
        }),
      );
      // Backdate openedAt so our fixture payments/expenses (dated within
      // the shift window) land inside [openedAt, asOf).
      await db
        .update(schema.registerShifts)
        .set({ openedAt })
        .where(eq(schema.registerShifts.id, shift.id));

      const cashOrder = await makeOrder(new Date("2024-01-01T09:00:00Z"));
      await makePayment(cashOrder, 20_000, "cash", new Date("2024-01-01T09:00:00Z"));
      // A card payment must NOT affect cash expected total.
      const cardOrder = await makeOrder(new Date("2024-01-01T09:05:00Z"));
      await makePayment(cardOrder, 15_000, "card", new Date("2024-01-01T09:05:00Z"));
      // A cash refund nets down the cash total.
      await makePayment(cashOrder, -5_000, "cash", new Date("2024-01-01T09:10:00Z"));
      // A cash expense reduces expected cash.
      await makeCashExpense(3_000, new Date("2024-01-01T09:15:00Z"));

      await db.transaction((tx) =>
        cashRegister.recordCashMovement(tx, {
          shiftId: shift.id,
          type: "addition",
          amountInPaisa: 2_000,
          recordedByUserId: cashierAId, timezone: "Asia/Kathmandu",
        }),
      );
      await db.transaction((tx) =>
        cashRegister.recordCashMovement(tx, {
          shiftId: shift.id,
          type: "drop",
          amountInPaisa: 1_000,
          recordedByUserId: cashierAId, timezone: "Asia/Kathmandu",
        }),
      );
      await db.transaction((tx) =>
        cashRegister.recordCashMovement(tx, {
          shiftId: shift.id,
          type: "payout",
          amountInPaisa: 500,
          recordedByUserId: cashierAId, timezone: "Asia/Kathmandu",
        }),
      );

      // opening 10_000 + net cash sales (20_000 - 5_000) - cash expenses
      // 3_000 + addition 2_000 - drop 1_000 - payout 500 = 22_500.
      // asOf = "now" (not a fixed past date) since the cash-movement rows
      // above were inserted with their real defaultNow() createdAt, same
      // as closeRegisterShift will use moments later below — both must
      // use a cutoff AFTER every fixture event actually landed.
      const expected = await db.transaction((tx) =>
        cashRegister.computeExpectedCashInPaisa(tx, {
          shiftId: shift.id,
          branchId,
          openingCashInPaisa: 10_000,
          openedAt,
          asOf: new Date(),
        }),
      );
      expect(expected).toBe(22_500);

      const closed = await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, {
          shiftId: shift.id,
          actualCashInPaisa: 22_000,
          closedByUserId: cashierAId, timezone: "Asia/Kathmandu",
        }),
      );
      expect(closed.expectedCashInPaisa).toBe(22_500);
      expect(closed.actualCashInPaisa).toBe(22_000);
      expect(closed.varianceInPaisa).toBe(-500);
    });

    it("prevents closing the same shift twice concurrently (CAS)", async () => {
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Double Close",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );

      const results = await Promise.allSettled([
        db.transaction((tx) =>
          cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 1_000, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
        ),
        db.transaction((tx) =>
          cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 999, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(cashRegister.CashRegisterError);
    });

    it("rejects recording a cash movement against an already-closed shift", async () => {
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Closed Movement",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );
      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 1_000, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
      );

      await expect(
        db.transaction((tx) =>
          cashRegister.recordCashMovement(tx, {
            shiftId: shift.id,
            type: "addition",
            amountInPaisa: 500,
            recordedByUserId: cashierAId, timezone: "Asia/Kathmandu",
          }),
        ),
      ).rejects.toBeInstanceOf(cashRegister.CashRegisterError);
    });
  });

  describe("correctRegisterShift", () => {
    it("appends a correction row and updates the shift's actual/variance without touching expectedCashInPaisa", async () => {
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Correction",
          openedByUserId: cashierAId,
          openingCashInPaisa: 4_000,
        }),
      );
      const closed = await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 4_000, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
      );
      expect(closed.expectedCashInPaisa).toBe(4_000);
      expect(closed.varianceInPaisa).toBe(0);

      const { shift: corrected, correction } = await db.transaction((tx) =>
        cashRegister.correctRegisterShift(tx, {
          shiftId: shift.id,
          newActualCashInPaisa: 3_800,
          reason: "TEST recount found a miscounted note",
          correctedByUserId: cashierBId,
          timezone: "Asia/Kathmandu",
        }),
      );

      expect(corrected.actualCashInPaisa).toBe(3_800);
      expect(corrected.varianceInPaisa).toBe(-200);
      expect(corrected.expectedCashInPaisa).toBe(4_000); // untouched
      expect(correction.previousActualCashInPaisa).toBe(4_000);
      expect(correction.newActualCashInPaisa).toBe(3_800);
      expect(correction.previousVarianceInPaisa).toBe(0);
      expect(correction.newVarianceInPaisa).toBe(-200);
      expect(correction.correctedByUserId).toBe(cashierBId);

      const historyRows = await db
        .select()
        .from(schema.registerShiftCorrections)
        .where(eq(schema.registerShiftCorrections.shiftId, shift.id));
      expect(historyRows).toHaveLength(1);
    });

    it("rejects correcting a shift that is still open", async () => {
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Correct Open",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );

      await expect(
        db.transaction((tx) =>
          cashRegister.correctRegisterShift(tx, {
            shiftId: shift.id,
            newActualCashInPaisa: 900,
            reason: "TEST should fail — still open",
            correctedByUserId: cashierBId,
            timezone: "Asia/Kathmandu",
          }),
        ),
      ).rejects.toBeInstanceOf(cashRegister.CashRegisterError);

      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 1_000, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
      );
    });

    it("rejects an empty correction reason", async () => {
      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Correct Empty Reason",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );
      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 1_000, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
      );

      await expect(
        db.transaction((tx) =>
          cashRegister.correctRegisterShift(tx, {
            shiftId: shift.id,
            newActualCashInPaisa: 900,
            reason: "   ",
            correctedByUserId: cashierBId,
            timezone: "Asia/Kathmandu",
          }),
        ),
      ).rejects.toBeInstanceOf(cashRegister.CashRegisterError);
    });
  });

  it("scopes expected cash to the shift's own branch — a cash sale at a different branch is not counted", async () => {
    const openedAt = new Date("2024-01-02T08:00:00Z");
    const shift = await db.transaction((tx) =>
      cashRegister.openRegisterShift(tx, {
        restaurantId,
        branchId,
        registerName: "TEST Register Branch Scoping",
        openedByUserId: cashierAId,
        openingCashInPaisa: 0,
      }),
    );
    await db.update(schema.registerShifts).set({ openedAt }).where(eq(schema.registerShifts.id, shift.id));

    // Order placed at the OTHER branch — must not count toward this shift.
    const [otherBranchOrder] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId: branchBId,
        orderNumber: (await import("@/lib/orders")).generateOrderNumber("UTC"),
        source: "pos",
        status: "completed",
        subtotalInPaisa: 9_000,
        taxInPaisa: 0,
        totalInPaisa: 9_000,
        placedAt: new Date("2024-01-02T09:00:00Z"),
      })
      .returning({ id: schema.orders.id });
    await makePayment(otherBranchOrder.id, 9_000, "cash", new Date("2024-01-02T09:00:00Z"));

    const expected = await db.transaction((tx) =>
      cashRegister.computeExpectedCashInPaisa(tx, {
        shiftId: shift.id,
        branchId,
        openingCashInPaisa: 0,
        openedAt,
        asOf: new Date("2024-01-02T23:59:59Z"),
      }),
    );
    expect(expected).toBe(0);

    await db.transaction((tx) =>
      cashRegister.closeRegisterShift(tx, { shiftId: shift.id, actualCashInPaisa: 0, closedByUserId: cashierAId, timezone: "Asia/Kathmandu", }),
    );
  });

  describe("QA hardening (Phase 5 / centralized daily-close lock)", () => {
    it("closeRegisterShift and recordCashMovement require MANAGE_DAILY_CLOSING once today's business day is closed for this branch, and allow it through for a role that holds it", async () => {
      const TZ = "UTC";
      const dailyClosing = await import("@/lib/daily-closing");
      const { restaurantDate } = await import("@/lib/restaurant-date");
      const today = restaurantDate(TZ);

      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId,
          registerName: "TEST Register Daily Close Lock",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );

      // Close TODAY's business day for this branch.
      await db.transaction((tx) =>
        dailyClosing.closeDailyBusiness(tx, {
          restaurantId,
          branchId,
          businessDate: today,
          timezone: TZ,
          closedByUserId: cashierAId,
        }),
      );

      // recordCashMovement — an ordinary role ("waiter" has no
      // MANAGE_DAILY_CLOSING per DEFAULT_ROLE_PERMISSIONS) is rejected.
      await expect(
        db.transaction((tx) =>
          cashRegister.recordCashMovement(tx, {
            shiftId: shift.id,
            type: "addition",
            amountInPaisa: 500,
            recordedByUserId: cashierAId,
            timezone: TZ,
            role: "waiter",
          }),
        ),
      ).rejects.toMatchObject({ status: 403 });

      // A role that DOES hold it ("owner" bypasses the permission matrix
      // entirely, same as requirePermission's own short-circuit) is let
      // through — the day being closed raises the trust bar, it doesn't
      // hard-block the mutation.
      const movement = await db.transaction((tx) =>
        cashRegister.recordCashMovement(tx, {
          shiftId: shift.id,
          type: "addition",
          amountInPaisa: 500,
          recordedByUserId: cashierAId,
          timezone: TZ,
          role: "owner",
        }),
      );
      expect(movement.amountInPaisa).toBe(500);

      // closeRegisterShift — same policy, same two branches.
      await expect(
        db.transaction((tx) =>
          cashRegister.closeRegisterShift(tx, {
            shiftId: shift.id,
            actualCashInPaisa: 1_500,
            closedByUserId: cashierAId,
            timezone: TZ,
            role: "waiter",
          }),
        ),
      ).rejects.toMatchObject({ status: 403 });

      const closed = await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, {
          shiftId: shift.id,
          actualCashInPaisa: 1_500,
          closedByUserId: cashierAId,
          timezone: TZ,
          role: "owner",
        }),
      );
      expect(closed.status).toBe("closed");
    });
  });

  describe("QA hardening (Phase 6 / connect cash payments to the cash register)", () => {
    it("assertRegisterOpenForCashPayment rejects when no register shift is open at the branch, and passes once one is", async () => {
      // branchBId never has a shift opened on it anywhere else in this
      // file (every open/close pair above uses `branchId`), so it's a
      // clean "definitely no open shift" fixture.
      await expect(
        db.transaction((tx) =>
          cashRegister.assertRegisterOpenForCashPayment(tx, { restaurantId, branchId: branchBId }),
        ),
      ).rejects.toMatchObject({ status: 400 });

      const shift = await db.transaction((tx) =>
        cashRegister.openRegisterShift(tx, {
          restaurantId,
          branchId: branchBId,
          registerName: "TEST Register Cash-Gate",
          openedByUserId: cashierAId,
          openingCashInPaisa: 1_000,
        }),
      );

      await expect(
        db.transaction((tx) =>
          cashRegister.assertRegisterOpenForCashPayment(tx, { restaurantId, branchId: branchBId }),
        ),
      ).resolves.toBeUndefined();

      // Once closed again, the gate re-engages.
      await db.transaction((tx) =>
        cashRegister.closeRegisterShift(tx, {
          shiftId: shift.id,
          actualCashInPaisa: 1_000,
          closedByUserId: cashierAId,
          timezone: "UTC",
        }),
      );
      await expect(
        db.transaction((tx) =>
          cashRegister.assertRegisterOpenForCashPayment(tx, { restaurantId, branchId: branchBId }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
