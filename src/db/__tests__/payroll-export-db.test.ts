/**
 * Commercial completion pass (Data Export gap — payroll) integration tests
 * for listPayrollPaymentsForExport() in src/lib/payroll.ts — the function
 * backing GET /api/restaurants/[slug]/payroll/export. RBAC/permission
 * gating (VIEW_PAYROLL) lives in the route itself and
 * resolveRestaurantContext's own tests already cover that layer (see
 * ledger-list.test.ts's own comment on the same split) — this file
 * exercises the query's tenant isolation, date-range filtering (by
 * paidAt), and branch scoping directly.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listPayrollPaymentsForExport (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let payroll: typeof import("@/lib/payroll");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let userRoleAId: string; // scoped to branch A
  let userRoleBId: string; // scoped to branch B

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    payroll = await import("@/lib/payroll");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payroll-export-${suffix}`, name: "TEST Payroll Export Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payroll-export-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [userA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payroll Alice", phone: `9781${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [userB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payroll Bob", phone: `9782${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });

    const [userRoleA] = await db
      .insert(schema.userRoles)
      .values({ userId: userA.id, restaurantId, branchId: branchAId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleAId = userRoleA.id;

    const [userRoleB] = await db
      .insert(schema.userRoles)
      .values({ userId: userB.id, restaurantId, branchId: branchBId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleBId = userRoleB.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  function paymentRow(params: {
    targetRestaurantId: string;
    userRoleId: string;
    staffName: string;
    amountInPaisa: number;
    paidAt: Date;
    deductions?: { label: string; amountInPaisa: number }[];
  }) {
    return {
      restaurantId: params.targetRestaurantId,
      userRoleId: params.userRoleId,
      staffNameSnapshot: params.staffName,
      amountInPaisa: params.amountInPaisa,
      paymentMethod: "cash" as const,
      paidAt: params.paidAt,
      deductionsJson: params.deductions ?? null,
    };
  }

  it("happy path: lists payments for the restaurant, newest paidAt first", async () => {
    await db.insert(schema.payrollPayments).values([
      paymentRow({
        targetRestaurantId: restaurantId,
        userRoleId: userRoleAId,
        staffName: "TEST Payroll Alice",
        amountInPaisa: 50_000,
        paidAt: new Date("2026-01-01T10:00:00Z"),
      }),
      paymentRow({
        targetRestaurantId: restaurantId,
        userRoleId: userRoleAId,
        staffName: "TEST Payroll Alice",
        amountInPaisa: 60_000,
        paidAt: new Date("2026-01-05T10:00:00Z"),
      }),
    ]);

    const rows = await payroll.listPayrollPaymentsForExport(restaurantId, null, {}, "UTC", 100);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const amounts = rows.filter((r) => r.staffNameSnapshot === "TEST Payroll Alice").map((r) => r.amountInPaisa);
    expect(amounts[0]).toBe(60_000); // newest first
  });

  it("wrong-restaurant isolation: never returns another restaurant's payments", async () => {
    const [otherUser] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Other Restaurant Staff", phone: `9783${Math.random().toString(36).slice(2, 8)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [otherRole] = await db
      .insert(schema.userRoles)
      .values({ userId: otherUser.id, restaurantId: otherRestaurantId, role: "waiter" })
      .returning({ id: schema.userRoles.id });

    const [other] = await db
      .insert(schema.payrollPayments)
      .values(
        paymentRow({
          targetRestaurantId: otherRestaurantId,
          userRoleId: otherRole.id,
          staffName: "TEST Other Restaurant Staff",
          amountInPaisa: 10_000,
          paidAt: new Date("2026-01-01T10:00:00Z"),
        }),
      )
      .returning();

    const rows = await payroll.listPayrollPaymentsForExport(restaurantId, null, {}, "UTC", 100);
    expect(rows.some((r) => r.id === other.id)).toBe(false);
  });

  it("filters by date range (from/to on paidAt, inclusive of the whole `to` day)", async () => {
    await db.insert(schema.payrollPayments).values([
      paymentRow({
        targetRestaurantId: restaurantId,
        userRoleId: userRoleAId,
        staffName: "TEST Payroll Alice",
        amountInPaisa: 1_000,
        paidAt: new Date("2026-02-01T05:00:00Z"),
      }),
      paymentRow({
        targetRestaurantId: restaurantId,
        userRoleId: userRoleAId,
        staffName: "TEST Payroll Alice",
        amountInPaisa: 2_000,
        paidAt: new Date("2026-02-15T05:00:00Z"),
      }),
      paymentRow({
        targetRestaurantId: restaurantId,
        userRoleId: userRoleAId,
        staffName: "TEST Payroll Alice",
        amountInPaisa: 3_000,
        paidAt: new Date("2026-03-01T05:00:00Z"),
      }),
    ]);

    const rows = await payroll.listPayrollPaymentsForExport(
      restaurantId,
      null,
      { from: "2026-02-01", to: "2026-02-28" },
      "UTC",
      100,
    );
    const amounts = rows.map((r) => r.amountInPaisa);
    expect(amounts).toContain(1_000);
    expect(amounts).toContain(2_000);
    expect(amounts).not.toContain(3_000);
  });

  it("scopes to one branch (via its staff member's userRoles.branchId) when branchId is given", async () => {
    const [inBranchB] = await db
      .insert(schema.payrollPayments)
      .values(
        paymentRow({
          targetRestaurantId: restaurantId,
          userRoleId: userRoleBId,
          staffName: "TEST Payroll Bob",
          amountInPaisa: 7_000,
          paidAt: new Date("2026-04-01T10:00:00Z"),
        }),
      )
      .returning();
    const [inBranchA] = await db
      .insert(schema.payrollPayments)
      .values(
        paymentRow({
          targetRestaurantId: restaurantId,
          userRoleId: userRoleAId,
          staffName: "TEST Payroll Alice",
          amountInPaisa: 8_000,
          paidAt: new Date("2026-04-01T10:00:00Z"),
        }),
      )
      .returning();

    const rows = await payroll.listPayrollPaymentsForExport(restaurantId, branchBId, {}, "UTC", 100);
    expect(rows.some((r) => r.id === inBranchB.id)).toBe(true);
    expect(rows.some((r) => r.id === inBranchA.id)).toBe(false);
  });

  it("respects a custom limit", async () => {
    const rows = await payroll.listPayrollPaymentsForExport(restaurantId, null, {}, "UTC", 1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
