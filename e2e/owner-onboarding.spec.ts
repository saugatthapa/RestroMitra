import { test, expect } from "@playwright/test";
import { randomPhone, teardownByOwnerPhone, E2E_PASSWORD } from "./db";

/**
 * Gap-audit P1 — owner onboarding (new restaurant registration through to
 * first dashboard view). This is the one critical first-run path the
 * existing E2E suite had zero coverage of: every other spec seeds its
 * restaurant directly via db.ts and jumps straight to a feature. Here the
 * whole point is to walk the REAL path a brand-new signup takes —
 * /register -> POST /api/auth/register -> /onboarding -> the 6-step
 * OnboardingWizard -> POST /api/onboarding/restaurant -> /dashboard —
 * through the real browser, not seeded shortcuts.
 *
 * Deliberately doesn't use seedOwnerRestaurant/teardownRestaurant from
 * db.ts (there's nothing to seed — the test IS the seeding flow); cleanup
 * instead looks the account up by phone after the fact via
 * teardownByOwnerPhone, since the owner/restaurant ids only exist by the
 * time registration has actually run.
 */

const ownerPhone = randomPhone();
const restaurantName = `TEST E2E Onboarding Restaurant ${Date.now()}`;

test.afterAll(async () => {
  await teardownByOwnerPhone(ownerPhone);
});

test("a brand-new owner can register, complete onboarding, and land on their dashboard", async ({ page }) => {
  // 1. Register a brand-new account through the real /register page.
  await page.goto("/register");
  await page.getByPlaceholder("Sita Rai").fill("TEST E2E Onboarding Owner");
  await page.getByPlaceholder("98XXXXXXXX").fill(ownerPhone);
  await page.getByPlaceholder("At least 8 characters").fill(E2E_PASSWORD);
  await page.getByPlaceholder("Re-enter your password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Start free trial" }).click();

  // register() redirects straight into /onboarding — no restaurant exists
  // for this brand-new user yet (see onboarding/page.tsx's own redirect
  // logic: 0 restaurants -> render the wizard; >0 -> bounce to /dashboard).
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.locator("body")).toContainText("What's your restaurant called?");

  // 2. Step 0 — restaurant name.
  await page.getByPlaceholder("e.g. Momo House Itahari").fill(restaurantName);
  await page.getByRole("button", { name: "Next" }).click();

  // 3. Step 1 — business type. Leave the pre-selected default ("Restaurant")
  // as-is, same "exercise the common case" reasoning as reservations.spec.ts
  // leaving the reservation form's default date/time alone.
  await expect(page.locator("body")).toContainText("What type of business is it?");
  await page.getByRole("button", { name: "Next" }).click();

  // 4. Step 2 — address & phone (all four fields are required to advance —
  // see OnboardingWizard's canAdvance() for step 2).
  await expect(page.locator("body")).toContainText("Where is it, and how can customers reach you?");
  await page.getByPlaceholder("Street address").fill("123 TEST Street");
  // City/District already default to "Itahari"/"Sunsari" — left as-is.
  await page.getByPlaceholder("Restaurant phone (98XXXXXXXX)").fill(randomPhone());
  await page.getByRole("button", { name: "Next" }).click();

  // 5. Step 3 — PAN/VAT (optional, skip).
  await expect(page.locator("body")).toContainText("PAN/VAT number (optional)");
  await page.getByRole("button", { name: "Next" }).click();

  // 6. Step 4 — opening hours (already defaulted to 08:00–21:00).
  await expect(page.locator("body")).toContainText("Opening hours");
  await page.getByRole("button", { name: "Next" }).click();

  // 7. Step 5 — review & create. Confirm the review screen actually reflects
  // what was entered before submitting — the concrete proof the wizard's
  // state carried through every step correctly, not just that SOME restaurant
  // got created.
  await expect(page.locator("body")).toContainText("Review & create");
  await expect(page.locator("body")).toContainText(restaurantName);
  await page.getByRole("button", { name: "Create restaurant" }).click();

  // POST /api/onboarding/restaurant resolves -> setDone(true) renders the
  // success screen with the restaurant name in its heading.
  await expect(page.locator("body")).toContainText(`${restaurantName} is set up`);
  await expect(page.locator("body")).toContainText("Restaurant profile & main branch created");
  await expect(page.locator("body")).toContainText("Owner account (TEST E2E Onboarding Owner) linked");

  // 8. "Go to dashboard" — the actual first-run destination.
  await page.getByRole("button", { name: "Go to dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // The dashboard shell renders the freshly-created restaurant's name (see
  // owner-login.spec.ts's identical assertion for why this — not just the
  // URL — is the real proof getUserRestaurants() picked up what onboarding
  // just created).
  await expect(page.locator("body")).toContainText(restaurantName);
  await expect(page.locator("body")).toContainText("Welcome back, TEST");

  // 9. A second visit to /onboarding itself should now bounce straight to
  // /dashboard (restaurants.length > 0) rather than re-showing the wizard —
  // the other half of onboarding/page.tsx's redirect logic, and a real
  // regression risk (a user hitting Back after finishing).
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/dashboard/);
});
