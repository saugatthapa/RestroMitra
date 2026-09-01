import { test, expect } from "@playwright/test";
import { generate } from "otplib";
import {
  seedPlatformAdmin,
  teardownPlatformAdmin,
  seedOwnerRestaurant,
  teardownRestaurant,
  E2E_PASSWORD,
  type SeededPlatformAdmin,
  type SeededRestaurant,
} from "./db";

/**
 * Closes the P0 gap flagged in RESTROMITRA_MASTER_GAP_AUDIT.md: zero
 * end-to-end coverage on the platform-admin console and impersonation flow
 * — the single most privileged surface in the app. This exercises the real
 * /login page's two-step MFA flow, /admin's platform-role gate
 * (src/app/admin/layout.tsx), the real /api/admin/impersonation/start and
 * /exit routes, and the dashboard layout's impersonation-context resolution
 * (src/app/dashboard/layout.tsx) — not any of those in isolation.
 *
 * MFA is not bypassed or special-cased away: the seeded platform admin
 * (e2e/db.ts's seedPlatformAdmin) has a real TOTP secret persisted exactly
 * the way enrollment persists one (see that helper's own comment), and
 * every test below computes a live 6-digit code from it with otplib's own
 * `generate()` — the same library and the same pattern
 * src/db/__tests__/mfa.test.ts already uses — and submits it through the
 * real two-step /login form, exactly like an authenticator app would.
 */

async function loginAsPlatformAdmin(page: import("@playwright/test").Page, admin: SeededPlatformAdmin) {
  // next=/admin: the login form's default post-login destination is
  // /dashboard (safeInternalRedirect's fallback — see safe-redirect.ts),
  // which would just bounce a platform admin with no restaurant of their
  // own straight to /onboarding. Real navigation to /admin (e.g. a
  // bookmark, or middleware bouncing an unauthenticated visit to /admin)
  // sets this same query param, so this isn't a test-only shortcut.
  await page.goto(`/login?next=${encodeURIComponent("/admin")}`);

  await page.getByPlaceholder("98XXXXXXXX").fill(admin.phone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  // A password-only submit for an MFA-enabled account never logs in
  // outright — the real API responds { mfaRequired: true, challengeToken }
  // and the form swaps in-place to its second step (see (auth)/login/page.tsx).
  await expect(page.getByRole("heading", { name: "Two-factor verification" })).toBeVisible();

  const code = await generate({ secret: admin.mfaSecret, period: 30 });
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
}

test.describe("platform admin console", () => {
  let target: SeededRestaurant;

  test.beforeAll(async () => {
    // The impersonation TARGET: an ordinary owner-seeded restaurant, no
    // different from any real tenant an admin would open from the list.
    // Shared across every test below — nothing here mutates it.
    target = await seedOwnerRestaurant("impersonation-target");
  });

  test.afterAll(async () => {
    await teardownRestaurant(target);
  });

  // A fresh platform admin per test, not one shared across the describe
  // block: mfa.ts's anti-replay protection (mfaLastUsedTimeStep) rejects a
  // TOTP code already used for its 30-second time step, and two tests
  // running back-to-back can easily land in the SAME 30-second window,
  // computing the identical code from a shared secret — a real login
  // would never hit this (a human takes longer than that between logins),
  // but two fast, sequential test logins against the same account can.
  // A distinct secret per test sidesteps that entirely rather than papering
  // over it with an artificial delay between tests.
  let admin: SeededPlatformAdmin;

  test.beforeEach(async () => {
    admin = await seedPlatformAdmin(`platform-admin-${Math.random().toString(36).slice(2, 8)}`);
  });

  test.afterEach(async () => {
    await teardownPlatformAdmin(admin);
  });

  test("platform admin logs in with MFA, reaches /admin, and sees the restaurant list", async ({ page }) => {
    await loginAsPlatformAdmin(page, admin);

    await expect(page).toHaveURL(/\/admin$/);
    // Proves the platform-role gate (admin/layout.tsx) actually resolved
    // this user's platform_admin grant, not just that some page rendered
    // — the header's own badge, matched exactly (the page also has a
    // "Platform admins" nav link and an owner-name link containing
    // "Platform Admin", both of which a substring match would collide with).
    await expect(page.getByText("Platform admin", { exact: true })).toBeVisible();
    // No MFA nag banner — the seeded account really does have MFA enabled,
    // not merely a role grant that would otherwise 403 on every action.
    await expect(page.locator("body")).not.toContainText(
      "Two-factor authentication is required for platform access",
    );

    // AdminOverview loads restaurants from the real /api/admin/restaurants
    // route — the concrete proof this test cares about is the actual
    // seeded restaurant showing up in that list, not just an empty table
    // rendering without error. Located by its detail-page href (not just
    // its name) so this can never accidentally match some other
    // restaurant that happens to share a name.
    const restaurantLink = page.locator(`a[href="/admin/restaurants/${target.restaurantId}"]`);
    await expect(restaurantLink).toBeVisible();
    await expect(restaurantLink).toContainText(target.name);
  });

  test("platform admin can impersonate a restaurant, see it reflected on /dashboard, and exit cleanly", async ({
    page,
  }) => {
    await loginAsPlatformAdmin(page, admin);
    await expect(page).toHaveURL(/\/admin$/);

    // Located by its detail-page href, not just its display name — see the
    // previous test's own comment on why.
    await page.locator(`a[href="/admin/restaurants/${target.restaurantId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/restaurants/${target.restaurantId}$`));
    await expect(page.getByRole("heading", { name: target.name })).toBeVisible();

    // The Suspension panel just above ImpersonationPanel on this same page
    // uses the exact same placeholder text for its own reason field
    // (both say "Reason (required, recorded in the audit log)…") — scope
    // everything to ImpersonationPanel's own container (identified by its
    // "Impersonate" heading) so this can never accidentally fill in or
    // click the wrong panel's controls.
    const impersonationPanel = page
      .getByRole("heading", { name: "Impersonate", level: 2 })
      .locator("xpath=ancestor::div[contains(@class,'border-amber-200')][1]");

    // Start impersonation: a mandatory reason and the "I understand..."
    // acknowledgment are both required before the button even enables
    // (see ImpersonationPanel's own `canStart` — this isn't testing a
    // disabled-button edge case, it's satisfying a real precondition to
    // reach the actual start action).
    const reason = `TEST E2E investigating a support ticket ${Date.now()}`;
    await impersonationPanel.getByPlaceholder("Reason (required, recorded in the audit log)…").fill(reason);
    await impersonationPanel.getByLabel(/I understand this action is logged/).check();

    const startButton = impersonationPanel.getByRole("button", { name: "Start impersonation" });
    await expect(startButton).toBeEnabled();
    await startButton.click();

    // ImpersonationPanel does a full navigation (window.location.href =
    // "/dashboard") specifically so the freshly-set impersonation cookie is
    // picked up on the very next request — wait for the real page landing,
    // not just the click resolving.
    await expect(page).toHaveURL(/\/dashboard/);

    // The persistent, un-hideable banner (ImpersonationBanner.tsx) is the
    // concrete proof an active impersonation session exists server-side,
    // not just that the button click "did something".
    await expect(page.getByText("Impersonating")).toBeVisible();
    await expect(page.locator("body")).toContainText(target.name);
    await expect(page.locator("body")).toContainText("read-only");
    await expect(page.locator("body")).toContainText(reason);

    // The dashboard itself must reflect the TARGET restaurant's context —
    // dashboard/layout.tsx resolves `active` from the impersonation
    // session, not from any userRoles row this admin holds (they hold
    // none), so the shell rendering the target's name is the real seam
    // this whole flow exists to protect.
    await expect(page.locator("body")).toContainText(target.name);

    // Exit: ends the session via the real /api/admin/impersonation/exit
    // route and clears the cookie server-side.
    await page.getByRole("button", { name: "Exit impersonation" }).click();
    await expect(page.getByText("Impersonating")).toHaveCount(0);

    // Back to normal, proven concretely: this platform admin holds no
    // userRoles grant of their own anywhere, so with impersonation
    // actually cleared, a fresh visit to /dashboard now falls through
    // dashboard/layout.tsx's real "no restaurants" branch and lands on
    // /onboarding — the same place any brand-new platform-admin-only
    // account would land. Seeing this (rather than the target
    // restaurant's dashboard again) is proof the impersonation grant is
    // actually gone server-side, not just that the banner's own component
    // unmounted client-side.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.locator("body")).not.toContainText(target.name);
    await expect(page.getByText("Restaurant name")).toBeVisible();
  });
});
