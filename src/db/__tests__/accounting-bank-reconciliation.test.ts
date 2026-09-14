/**
 * Integration tests for src/lib/accounting/bank-reconciliation.ts — Phase
 * 5, Slice 5b's bank-STATEMENT-level reconciliation (distinct from Slice
 * 4f's per-PAYMENT reconciliation in integrations/reconciliation.ts). See
 * completeBankReconciliation's own doc comment for the balance/difference
 * arithmetic this test suite verifies.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — bank statement reconciliation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let bankAccountsLib: typeof import("@/lib/accounting/bank-accounts");
  let bankReconLib: typeof import("@/lib/accounting/bank-reconciliation");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let salesAccountId: string;
  let salaryExpenseAccountId: string;
  let bankAId: string; // bank_accounts.id
  let bankAChartAccountId: string;
  let bankBId: string;

  const post = (voucherDate: string, lines: Parameters<typeof postVoucherLib.postVoucher>[1]["lines"]) =>
    db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherDate,
        createdByUserId: userId,
        lines,
      }),
    );

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    bankAccountsLib = await import("@/lib/accounting/bank-accounts");
    bankReconLib = await import("@/lib/accounting/bank-reconciliation");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-bank-recon-${suffix}`, name: "TEST Bank Reconciliation Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Recon Accountant", phone: `979${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const [sales] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "4000")));
    salesAccountId = sales.id;
    const [salary] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "5100")));
    salaryExpenseAccountId = salary.id;

    const bankA = await db.transaction((tx) =>
      bankAccountsLib.provisionBankAccount(tx, { restaurantId, bankName: "TEST Recon Bank A", createdByUserId: userId }),
    );
    bankAId = bankA.id;
    bankAChartAccountId = bankA.chartOfAccountsId;

    const bankB = await db.transaction((tx) =>
      bankAccountsLib.provisionBankAccount(tx, { restaurantId, bankName: "TEST Recon Bank B", createdByUserId: userId }),
    );
    bankBId = bankB.id;

    // Bank A: a 1000 deposit (Jan 1), a 300 withdrawal (Jan 10), and a
    // 200 deposit dated AFTER the Jan 31 statement cutoff used below — to
    // prove date filtering excludes it entirely.
    await post("2025-01-01", [
      { accountId: bankAChartAccountId, debitInPaisa: 1000_00 },
      { accountId: salesAccountId, creditInPaisa: 1000_00 },
    ]);
    await post("2025-01-10", [
      { accountId: salaryExpenseAccountId, debitInPaisa: 300_00 },
      { accountId: bankAChartAccountId, creditInPaisa: 300_00 },
    ]);
    await post("2025-02-15", [
      { accountId: bankAChartAccountId, debitInPaisa: 200_00 },
      { accountId: salesAccountId, creditInPaisa: 200_00 },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("createBankReconciliation rejects an inactive or foreign bank account", async () => {
    await db.transaction((tx) =>
      bankAccountsLib.updateBankAccount(tx, { restaurantId, bankAccountId: bankBId, isActive: false }),
    );
    await expect(
      db.transaction((tx) =>
        bankReconLib.createBankReconciliation(tx, {
          restaurantId,
          bankAccountId: bankBId,
          statementDate: "2025-01-31",
          statementClosingBalanceInPaisa: 0,
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/inactive/);
    await db.transaction((tx) =>
      bankAccountsLib.updateBankAccount(tx, { restaurantId, bankAccountId: bankBId, isActive: true }),
    );

    await expect(
      db.transaction((tx) =>
        bankReconLib.createBankReconciliation(tx, {
          restaurantId,
          bankAccountId: "00000000-0000-0000-0000-000000000000",
          statementDate: "2025-01-31",
          statementClosingBalanceInPaisa: 0,
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("workspace excludes lines dated after the statement date, and lines cleared by a DIFFERENT reconciliation for the same bank account", async () => {
    const reconA1 = await db.transaction((tx) =>
      bankReconLib.createBankReconciliation(tx, {
        restaurantId,
        bankAccountId: bankAId,
        statementDate: "2025-01-31",
        statementClosingBalanceInPaisa: 700_00,
        createdByUserId: userId,
      }),
    );
    const reconA2 = await db.transaction((tx) =>
      bankReconLib.createBankReconciliation(tx, {
        restaurantId,
        bankAccountId: bankAId,
        statementDate: "2025-01-31",
        statementClosingBalanceInPaisa: 700_00,
        createdByUserId: userId,
      }),
    );

    const workspace1 = await db.transaction((tx) =>
      bankReconLib.getReconciliationWorkspace(tx, { restaurantId, reconciliationId: reconA1.id }),
    );
    // Only the Jan 1 and Jan 10 lines — the Feb 15 line is after the Jan 31
    // cutoff.
    expect(workspace1.lines.length).toBe(2);
    expect(workspace1.lines.every((l) => l.cleared === false)).toBe(true);

    const janFirstLine = workspace1.lines.find((l) => l.voucherDate === "2025-01-01")!;

    await db.transaction((tx) =>
      bankReconLib.setClearedLines(tx, {
        restaurantId,
        reconciliationId: reconA1.id,
        voucherLineIds: [janFirstLine.id],
      }),
    );

    const workspace2 = await db.transaction((tx) =>
      bankReconLib.getReconciliationWorkspace(tx, { restaurantId, reconciliationId: reconA2.id }),
    );
    // The line just cleared by reconA1 must be entirely ABSENT from
    // reconA2's workspace (it belongs to that other checklist now), while
    // the Jan 10 line — still unclaimed — is still visible here.
    expect(workspace2.lines.find((l) => l.id === janFirstLine.id)).toBeUndefined();
    expect(workspace2.lines.length).toBe(1);

    // setClearedLines should silently skip a line already claimed by a
    // DIFFERENT reconciliation, not error the whole request.
    const { skipped } = await db.transaction((tx) =>
      bankReconLib.setClearedLines(tx, {
        restaurantId,
        reconciliationId: reconA2.id,
        voucherLineIds: [janFirstLine.id, workspace2.lines[0].id],
      }),
    );
    expect(skipped).toEqual([janFirstLine.id]);

    // Clean up reconA2 (still open) so it doesn't interfere with the
    // "complete reconA1" test below — its skipped attempt above did NOT
    // actually claim janFirstLine (confirmed by the skip itself), but it
    // DID successfully claim the Jan 10 line, which reconA1 needs back.
    await db.transaction((tx) => bankReconLib.deleteOpenBankReconciliation(tx, { restaurantId, reconciliationId: reconA2.id }));

    // Un-claim the Jan 1 line from reconA1 too, resetting bank A to a clean
    // slate for the "complete" tests below, which re-derive their own
    // cleared set from scratch.
    await db.transaction((tx) =>
      bankReconLib.setClearedLines(tx, { restaurantId, reconciliationId: reconA1.id, voucherLineIds: [] }),
    );
    await db.transaction((tx) => bankReconLib.deleteOpenBankReconciliation(tx, { restaurantId, reconciliationId: reconA1.id }));
  });

  it("completeBankReconciliation is exact (difference 0) when every line up to the statement date is cleared and the closing balance matches", async () => {
    const recon = await db.transaction((tx) =>
      bankReconLib.createBankReconciliation(tx, {
        restaurantId,
        bankAccountId: bankAId,
        statementDate: "2025-01-31",
        statementClosingBalanceInPaisa: 700_00, // 1000 - 300
        createdByUserId: userId,
      }),
    );
    const workspace = await db.transaction((tx) =>
      bankReconLib.getReconciliationWorkspace(tx, { restaurantId, reconciliationId: recon.id }),
    );
    expect(workspace.lines.length).toBe(2);

    await db.transaction((tx) =>
      bankReconLib.setClearedLines(tx, {
        restaurantId,
        reconciliationId: recon.id,
        voucherLineIds: workspace.lines.map((l) => l.id),
      }),
    );

    const completed = await db.transaction((tx) =>
      bankReconLib.completeBankReconciliation(tx, { restaurantId, reconciliationId: recon.id, completedByUserId: userId }),
    );
    expect(completed.status).toBe("completed");
    expect(completed.bookBalanceInPaisa).toBe(700_00);
    expect(completed.differenceInPaisa).toBe(0);

    // Completed reconciliations can't be deleted or re-edited.
    await expect(
      db.transaction((tx) => bankReconLib.deleteOpenBankReconciliation(tx, { restaurantId, reconciliationId: recon.id })),
    ).rejects.toThrow(/completed reconciliation can't be deleted/);
    await expect(
      db.transaction((tx) =>
        bankReconLib.setClearedLines(tx, { restaurantId, reconciliationId: recon.id, voucherLineIds: [] }),
      ),
    ).rejects.toThrow(/reopen it/);

    // Reopening resets the completion fields but keeps every line cleared.
    const reopened = await db.transaction((tx) =>
      bankReconLib.reopenBankReconciliation(tx, { restaurantId, reconciliationId: recon.id }),
    );
    expect(reopened.status).toBe("open");
    expect(reopened.bookBalanceInPaisa).toBeNull();
    expect(reopened.differenceInPaisa).toBeNull();
    expect(reopened.completedAt).toBeNull();

    const workspaceAfterReopen = await db.transaction((tx) =>
      bankReconLib.getReconciliationWorkspace(tx, { restaurantId, reconciliationId: recon.id }),
    );
    expect(workspaceAfterReopen.lines.every((l) => l.cleared)).toBe(true);

    // Now that it's open again, it CAN be deleted.
    await db.transaction((tx) => bankReconLib.deleteOpenBankReconciliation(tx, { restaurantId, reconciliationId: recon.id }));
  });

  it("completeBankReconciliation surfaces (not blocks) a real difference between what's cleared and the statement's own closing balance", async () => {
    // Bank B: a single 1000 deposit, statement says 950 (a discrepancy —
    // e.g. an unrecorded bank fee) even though the ledger and the human's
    // own checklist agree the line is genuinely cleared.
    const [bankBChart] = await db
      .select({ chartOfAccountsId: schema.bankAccounts.chartOfAccountsId })
      .from(schema.bankAccounts)
      .where(eq(schema.bankAccounts.id, bankBId));

    await post("2025-02-01", [
      { accountId: bankBChart.chartOfAccountsId, debitInPaisa: 1000_00 },
      { accountId: salesAccountId, creditInPaisa: 1000_00 },
    ]);

    const recon = await db.transaction((tx) =>
      bankReconLib.createBankReconciliation(tx, {
        restaurantId,
        bankAccountId: bankBId,
        statementDate: "2025-02-28",
        statementClosingBalanceInPaisa: 950_00,
        createdByUserId: userId,
      }),
    );
    const workspace = await db.transaction((tx) =>
      bankReconLib.getReconciliationWorkspace(tx, { restaurantId, reconciliationId: recon.id }),
    );
    await db.transaction((tx) =>
      bankReconLib.setClearedLines(tx, {
        restaurantId,
        reconciliationId: recon.id,
        voucherLineIds: workspace.lines.map((l) => l.id),
      }),
    );

    const completed = await db.transaction((tx) =>
      bankReconLib.completeBankReconciliation(tx, { restaurantId, reconciliationId: recon.id, completedByUserId: userId }),
    );
    // Completion SUCCEEDS despite the mismatch — it's recorded, not blocked.
    expect(completed.status).toBe("completed");
    expect(completed.bookBalanceInPaisa).toBe(1000_00);
    expect(completed.differenceInPaisa).toBe(50_00); // 1000 cleared - 950 statement
  });
});
