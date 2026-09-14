/**
 * Integration tests for src/lib/accounting/bank-accounts.ts — Phase 5,
 * Slice 5b's real bank accounts and the picker/legacy-fallback resolution
 * rules in resolveBankAccountForPosting (see that function's own doc
 * comment for the full decision table this test suite exercises).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — bank accounts (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let mappingKeys: typeof import("@/lib/accounting/account-mapping-keys");
  let bankAccountsLib: typeof import("@/lib/accounting/bank-accounts");

  let restaurantId: string;
  let userId: string;
  let bankDigitalPaymentsAccountId: string; // 1040

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    mappingKeys = await import("@/lib/accounting/account-mapping-keys");
    bankAccountsLib = await import("@/lib/accounting/bank-accounts");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-bank-accounts-${suffix}`, name: "TEST Bank Accounts Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    await db.insert(schema.branches).values({ restaurantId, name: "Main", isMain: true });

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Bank Accountant", phone: `978${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const [bankDigital] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "1040")));
    bankDigitalPaymentsAccountId = bankDigital.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("resolveBankAccountForPosting falls back to the legacy mapped account when no bank_accounts rows exist yet", async () => {
    const resolved = await db.transaction((tx) =>
      bankAccountsLib.resolveBankAccountForPosting(tx, {
        restaurantId,
        requestedBankAccountId: null,
        legacyMappingKey: mappingKeys.MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
      }),
    );
    expect(resolved).toBe(bankDigitalPaymentsAccountId);
  });

  it("provisionBankAccount creates a chart_of_accounts child under 1050 with a code in the reserved 1051-1099 block", async () => {
    const bankAccount = await db.transaction((tx) =>
      bankAccountsLib.provisionBankAccount(tx, {
        restaurantId,
        bankName: "TEST Nabil Bank",
        accountNumber: "0012345678",
        createdByUserId: userId,
      }),
    );

    expect(Number(bankAccount.code)).toBeGreaterThanOrEqual(1051);
    expect(Number(bankAccount.code)).toBeLessThanOrEqual(1099);

    const [account] = await db
      .select()
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.id, bankAccount.chartOfAccountsId));
    expect(account.type).toBe("asset");
    expect(account.normalBalance).toBe("debit");
    expect(account.isSystemAccount).toBe(false);

    const [parent] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "1050")));
    expect(account.parentAccountId).toBe(parent.id);
  });

  it("resolveBankAccountForPosting silently uses the single active bank account once one exists, ignoring the legacy mapping", async () => {
    const resolved = await db.transaction((tx) =>
      bankAccountsLib.resolveBankAccountForPosting(tx, {
        restaurantId,
        requestedBankAccountId: null,
        legacyMappingKey: mappingKeys.MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
      }),
    );
    const [onlyBankAccount] = await db
      .select()
      .from(schema.bankAccounts)
      .where(eq(schema.bankAccounts.restaurantId, restaurantId));
    expect(resolved).toBe(onlyBankAccount.chartOfAccountsId);
    expect(resolved).not.toBe(bankDigitalPaymentsAccountId);
  });

  it("resolveBankAccountForPosting requires an explicit choice once more than one active bank account exists", async () => {
    const second = await db.transaction((tx) =>
      bankAccountsLib.provisionBankAccount(tx, {
        restaurantId,
        bankName: "TEST Nepal Investment Bank",
        createdByUserId: userId,
      }),
    );

    await expect(
      db.transaction((tx) =>
        bankAccountsLib.resolveBankAccountForPosting(tx, {
          restaurantId,
          requestedBankAccountId: null,
          legacyMappingKey: mappingKeys.MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
        }),
      ),
    ).rejects.toThrow(/more than one active bank account/);

    const resolved = await db.transaction((tx) =>
      bankAccountsLib.resolveBankAccountForPosting(tx, {
        restaurantId,
        requestedBankAccountId: second.id,
        legacyMappingKey: mappingKeys.MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
      }),
    );
    expect(resolved).toBe(second.chartOfAccountsId);
  });

  it("resolveBankAccountForPosting throws for a requested bank account that doesn't belong to this restaurant or isn't active", async () => {
    await expect(
      db.transaction((tx) =>
        bankAccountsLib.resolveBankAccountForPosting(tx, {
          restaurantId,
          requestedBankAccountId: "00000000-0000-0000-0000-000000000000",
          legacyMappingKey: mappingKeys.MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
        }),
      ),
    ).rejects.toThrow(/isn't active, or doesn't belong/);
  });

  it("updateBankAccount toggles isActive on both the bank_accounts row and its wrapped ledger account, and deactivating all active ones makes resolveBankAccountForPosting throw rather than fall back to the legacy account", async () => {
    const accounts = await db.transaction((tx) => bankAccountsLib.listBankAccounts(tx, restaurantId));
    expect(accounts.length).toBe(2);

    for (const acc of accounts) {
      const updated = await db.transaction((tx) =>
        bankAccountsLib.updateBankAccount(tx, { restaurantId, bankAccountId: acc.id, isActive: false }),
      );
      expect(updated.isActive).toBe(false);
      const [ledgerAccount] = await db
        .select({ isActive: schema.chartOfAccounts.isActive })
        .from(schema.chartOfAccounts)
        .where(eq(schema.chartOfAccounts.id, acc.chartOfAccountsId));
      expect(ledgerAccount.isActive).toBe(false);
    }

    await expect(
      db.transaction((tx) =>
        bankAccountsLib.resolveBankAccountForPosting(tx, {
          restaurantId,
          requestedBankAccountId: null,
          legacyMappingKey: mappingKeys.MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
        }),
      ),
    ).rejects.toThrow(/No active bank account/);
  });

  it("ensureLegacyBankAccountsWrapped wraps only a legacy account that actually has posted voucher lines, and is a no-op once any bank_accounts row already exists", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [freshRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-bank-wrap-${suffix}`, name: "TEST Bank Wrap Restaurant" })
      .returning({ id: schema.restaurants.id });
    const freshRestaurantId = freshRestaurant.id;
    const [freshBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: freshRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    const freshBranchId = freshBranch.id;

    try {
      await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId: freshRestaurantId }));

      const [freshBankDigital] = await db
        .select({ id: schema.chartOfAccounts.id })
        .from(schema.chartOfAccounts)
        .where(
          and(eq(schema.chartOfAccounts.restaurantId, freshRestaurantId), eq(schema.chartOfAccounts.code, "1040")),
        );
      const [freshCash] = await db
        .select({ id: schema.chartOfAccounts.id })
        .from(schema.chartOfAccounts)
        .where(and(eq(schema.chartOfAccounts.restaurantId, freshRestaurantId), eq(schema.chartOfAccounts.code, "1000")));

      // Post a journal voucher touching 1040 (Bank / Digital Payments) —
      // 1045 (Bank Account) is left completely untouched, so it should
      // NOT get wrapped below (never actually used).
      await db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId: freshRestaurantId,
          branchId: freshBranchId,
          voucherType: "journal",
          voucherDate: "2025-06-01",
          createdByUserId: userId,
          lines: [
            { accountId: freshBankDigital.id, debitInPaisa: 500_00 },
            { accountId: freshCash.id, creditInPaisa: 500_00 },
          ],
        }),
      );

      await db.transaction((tx) =>
        bankAccountsLib.ensureLegacyBankAccountsWrapped(tx, { restaurantId: freshRestaurantId, wrappedByUserId: userId }),
      );

      const wrapped = await db.transaction((tx) => bankAccountsLib.listBankAccounts(tx, freshRestaurantId));
      expect(wrapped.length).toBe(1);
      expect(wrapped[0].chartOfAccountsId).toBe(freshBankDigital.id);
      expect(wrapped[0].bankName).toBe("Digital Payments (default)");

      // Re-running is a no-op — already has a bank_accounts row.
      await db.transaction((tx) =>
        bankAccountsLib.ensureLegacyBankAccountsWrapped(tx, { restaurantId: freshRestaurantId, wrappedByUserId: userId }),
      );
      const wrappedAgain = await db.transaction((tx) => bankAccountsLib.listBankAccounts(tx, freshRestaurantId));
      expect(wrappedAgain.length).toBe(1);
    } finally {
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, freshRestaurantId));
    }
  });
});
