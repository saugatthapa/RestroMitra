import { test, expect } from "@playwright/test";
import { generate } from "otplib";
import { seedOwnerRestaurant, seedStaffMember, teardownRestaurant, E2E_PASSWORD, type SeededRestaurant } from "./db";

/**
 * Gap-audit P1 — running a payroll payment for a staff member end-to-end
 * through the dashboard UI (Staff > Payroll tab). Deliberately doesn't
 * pre-seed a standing salary config — the "Pay" flow works without one
 * (see PaySalaryModal: "No standing salary set — enter the amount to pay
 * below."), so this exercises the plainer, more common first-payment path
 * a real owner takes before ever setting up a formal salary record.
 *
 * Seeds the owner with MFA already enrolled (`mfaEnabled: true`) and logs
 * in through the real two-step /login form — POST /payroll/payments is one
 * of the routes requireOwnerMfaEnabled (guard.ts) gates behind owner MFA
 * (gap-audit P1, same wave as this spec), so an owner without it would
 * 403 on the exact "Mark as paid" submit this test drives. Same "seed the
 * end state directly, then submit a live TOTP code through the real form"
 * pattern platform-admin.spec.ts already established for seedPlatformAdmin.
 */

let r: SeededRestaurant;
let staffFullName: string;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("payroll", { mfaEnabled: true });
  staffFullName = `TEST Payroll Staff ${Date.now()}`;
  await seedStaffMember(r, { role: "waiter", fullName: staffFullName });
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("owner can record a payroll payment for a staff member and see it on the roster and payments history", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  // A password-only submit for an MFA-enabled account never logs in
  // outright — the real API responds { mfaRequired: true, challengeToken }
  // and the form swaps in-place to its second step (see (auth)/login/page.tsx),
  // same two-step flow platform-admin.spec.ts's loginAsPlatformAdmin drives.
  await expect(page.getByRole("heading", { name: "Two-factor verification" })).toBeVisible();
  const code = await generate({ secret: r.mfaSecret!, period: 30 });
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/staff");
  await page.getByRole("button", { name: "Payroll" }).click();

  // Before paying: the roster row shows "Not set" for salary and "Never"
  // for last paid — the concrete starting state this test is changing.
  // Scoped to the roster table specifically (identified by its "Owed
  // (period)" header) rather than a bare `tr` match against the whole
  // page — once a payment is recorded, the payments-history table below
  // ALSO gains a row containing the staff member's name, and an unscoped
  // locator would then resolve to both (a Playwright strict-mode
  // violation on the very next assertion).
  const rosterTable = page.locator("table", { hasText: "Owed (period)" });
  const staffRow = rosterTable.locator("tr", { hasText: staffFullName });
  await expect(staffRow).toBeVisible();
  await expect(staffRow).toContainText("Never");

  await staffRow.getByRole("button", { name: "Pay" }).click();

  // PaySalaryModal — a plain modal <form>, matched the same way
  // reservations.spec.ts matches AddReservationForm's fields (a <label>
  // implicitly wrapping its <input>).
  await expect(page.locator("body")).toContainText(`Pay ${staffFullName}`);
  await page.getByLabel("Amount (Rs)").fill("5500");
  // "Paid via" left at its default (Cash) — the common case, and the modal
  // itself explains cash needs no further confirmation.
  await page.getByLabel(/Period \(optional/).fill("TEST August 2026");
  await page.getByRole("button", { name: "Mark as paid" }).click();

  // Modal closes and the roster reloads — "Never" becomes an actual paid
  // date for this staff member specifically (not just "any date shows up
  // somewhere on the page").
  await expect(page.getByText(`Pay ${staffFullName}`)).not.toBeVisible();
  await expect(staffRow).not.toContainText("Never");

  // The payments history table below is the real receipt: staff name,
  // period label, and the exact amount recorded (formatNPR renders paisa
  // as "Rs. 5,500.00" — see src/lib/money.ts).
  const paymentsTable = page.locator("table", { hasText: "Method" });
  await expect(paymentsTable).toContainText(staffFullName);
  await expect(paymentsTable).toContainText("TEST August 2026");
  await expect(paymentsTable).toContainText(/Rs\.\s*5,500\.00/);

  // The payslip link is a real, working artifact of this payment — not
  // just a row in a table. Opens in a new tab (target="_blank"), same as
  // the KOT ticket print link elsewhere in this app.
  const [payslipPage] = await Promise.all([
    page.waitForEvent("popup"),
    paymentsTable.getByRole("link", { name: "Payslip" }).click(),
  ]);
  await payslipPage.waitForLoadState();
  await expect(payslipPage.locator("body")).toContainText(staffFullName);
  await expect(payslipPage.locator("body")).toContainText(/Rs\.\s*5,500\.00/);
  await payslipPage.close();
});
