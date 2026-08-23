import { test, expect } from "@playwright/test";
import { seedOwnerRestaurant, teardownRestaurant, E2E_PASSWORD, type SeededRestaurant } from "./db";

/**
 * Highest-value flow #1: an owner logging into their own dashboard. This
 * exercises the real /login page, POST /api/auth/login, session-cookie
 * issuance, and the dashboard layout's redirect/subscription-access logic
 * (src/app/dashboard/layout.tsx) — not just the API route in isolation.
 */

let r: SeededRestaurant;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("owner-login");
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("owner can log in and lands on their dashboard", async ({ page }) => {
  await page.goto("/login");

  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  // The dashboard shell renders the active restaurant's name (see
  // DashboardShell's `restaurantName` prop in dashboard/layout.tsx) — this
  // is the concrete proof that getUserRestaurants()/session resolution
  // actually picked up the restaurant this test seeded, not just that
  // *some* redirect to /dashboard happened.
  await expect(page.locator("body")).toContainText("TEST E2E owner-login Restaurant");
});

test("wrong password is rejected with an inline error, not a redirect", async ({ page }) => {
  await page.goto("/login");

  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill("definitely-wrong-password-1");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("body")).toContainText(/invalid|incorrect|could not/i);
});
