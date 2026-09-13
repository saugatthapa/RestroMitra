import "server-only";
import { eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { chartOfAccounts, accountMappings, type accountTypeEnum, type accountNormalBalanceEnum } from "@/db/schema";
import { MAPPING_KEYS, type MappingKey } from "@/lib/accounting/account-mapping-keys";

type AccountType = (typeof accountTypeEnum.enumValues)[number];
type NormalBalance = (typeof accountNormalBalanceEnum.enumValues)[number];

type SeedAccount = {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  // Which account_mappings key(s) this account is the default target for —
  // most accounts back exactly one, a few back none (there's no automatic
  // event that posts to Fixed Assets in Phase 1, for instance).
  mappingKeys?: MappingKey[];
};

/**
 * The exact chart of accounts ACCOUNTING_POLICY_AND_POSTING_MATRIX.md
 * defines — deliberately not a generic textbook COA: every account here
 * exists because a specific row in that document needs it. Flat (no
 * parent/child grouping) for Phase 1; chartOfAccounts.parentAccountId
 * exists in the schema for a restaurant that wants to organize sub-accounts
 * later without a migration.
 *
 * Kept in the same file as the seed function (not split into a bare data
 * file) since the two are only ever used together and this keeps the
 * mapping-key wiring visible in one place.
 */
const DEFAULT_CHART_OF_ACCOUNTS: SeedAccount[] = [
  { code: "1000", name: "Cash on Hand", type: "asset", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.PAYMENT_METHOD_CASH] },
  { code: "1010", name: "Card Clearing", type: "asset", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.PAYMENT_METHOD_CARD] },
  { code: "1020", name: "Mobile Wallet Clearing", type: "asset", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.PAYMENT_METHOD_MOBILE_WALLET] },
  { code: "1030", name: "Other Clearing", type: "asset", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.PAYMENT_METHOD_OTHER] },
  { code: "1100", name: "Accounts Receivable", type: "asset", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.ACCOUNTS_RECEIVABLE] },
  { code: "1200", name: "Inventory", type: "asset", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.INVENTORY] },
  { code: "1900", name: "Fixed Assets", type: "asset", normalBalance: "debit" },
  // Contra-asset — accumulated depreciation reduces total assets even
  // though the account type is "asset". See chart_of_accounts.normalBalance's
  // own column comment for why this is a real, deliberate column, not a
  // value derivable from `type`.
  { code: "1910", name: "Accumulated Depreciation", type: "asset", normalBalance: "credit" },
  { code: "2000", name: "Accounts Payable", type: "liability", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.ACCOUNTS_PAYABLE] },
  { code: "2100", name: "Tax Payable", type: "liability", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.TAX_PAYABLE] },
  { code: "2200", name: "Tips Payable", type: "liability", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.TIPS_PAYABLE] },
  { code: "2300", name: "Salary Payable", type: "liability", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.SALARY_PAYABLE] },
  { code: "2400", name: "Loans Payable", type: "liability", normalBalance: "credit" },
  { code: "3000", name: "Owner Capital", type: "equity", normalBalance: "credit" },
  // Contra-equity.
  { code: "3100", name: "Owner Drawings", type: "equity", normalBalance: "debit" },
  { code: "3200", name: "Opening Balance Equity", type: "equity", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.OPENING_BALANCE_EQUITY] },
  { code: "4000", name: "Sales Revenue", type: "income", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.SALES_REVENUE] },
  { code: "4010", name: "Service Charge Revenue", type: "income", normalBalance: "credit", mappingKeys: [MAPPING_KEYS.SERVICE_CHARGE_REVENUE] },
  // Contra-income (decision confirmed in ACCOUNTING_MODULE_PLAN.md).
  { code: "4900", name: "Discounts & Allowances", type: "income", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.DISCOUNTS_AND_ALLOWANCES] },
  { code: "4910", name: "Sales Returns & Refunds", type: "income", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.SALES_RETURNS_AND_REFUNDS] },
  { code: "5000", name: "Cost of Goods Sold", type: "expense", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.COST_OF_GOODS_SOLD] },
  { code: "5100", name: "Salary Expense", type: "expense", normalBalance: "debit", mappingKeys: [MAPPING_KEYS.SALARY_EXPENSE] },
];

export type SeedChartOfAccountsResult = {
  accountsCreated: number;
  mappingsCreated: number;
};

/**
 * Seeds the default chart of accounts + default account_mappings for a
 * restaurant. Idempotent: safe to call more than once (e.g. re-run after a
 * partial failure) — existing rows (matched by restaurantId+code for
 * accounts, restaurantId+mappingKey for mappings) are left untouched, never
 * overwritten, so any manual edits a restaurant has already made survive a
 * re-run.
 *
 * Deliberately does NOT seed per-expense-category accounts (5200+ in the
 * posting matrix) — those are created on demand as a restaurant's actual
 * expense categories are mapped, via the Chart of Accounts / mappings API,
 * not guessed here.
 */
export async function seedDefaultChartOfAccounts(
  tx: Transaction,
  params: { restaurantId: string },
): Promise<SeedChartOfAccountsResult> {
  const inserted = await tx
    .insert(chartOfAccounts)
    .values(
      DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
        restaurantId: params.restaurantId,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isSystemAccount: true,
      })),
    )
    .onConflictDoNothing({ target: [chartOfAccounts.restaurantId, chartOfAccounts.code] })
    .returning({ id: chartOfAccounts.id, code: chartOfAccounts.code });

  // Mappings are wired from whatever now exists for this restaurant (either
  // just-inserted above, or already there from a prior run) — a second
  // query rather than relying on `inserted`, since onConflictDoNothing
  // doesn't return skipped rows.
  const allAccounts = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.restaurantId, params.restaurantId));
  const accountIdByCode = new Map(allAccounts.map((a) => [a.code, a.id]));

  const mappingRows: Array<{ restaurantId: string; mappingKey: string; accountId: string }> = [];
  for (const a of DEFAULT_CHART_OF_ACCOUNTS) {
    if (!a.mappingKeys) continue;
    const accountId = accountIdByCode.get(a.code);
    if (!accountId) continue;
    for (const key of a.mappingKeys) {
      mappingRows.push({ restaurantId: params.restaurantId, mappingKey: key, accountId });
    }
  }

  let mappingsCreated = 0;
  if (mappingRows.length > 0) {
    const insertedMappings = await tx
      .insert(accountMappings)
      .values(mappingRows)
      .onConflictDoNothing({ target: [accountMappings.restaurantId, accountMappings.mappingKey] })
      .returning({ id: accountMappings.id });
    mappingsCreated = insertedMappings.length;
  }

  return { accountsCreated: inserted.length, mappingsCreated };
}
