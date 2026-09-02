import { test, expect } from "@playwright/test";
import { seedOwnerRestaurant, teardownRestaurant, expireSessionForUser, E2E_PASSWORD, type SeededRestaurant } from "./db";

/**
 * Gap-audit P1 — expired-session handling. A session that's been
 * invalidated must redirect to /login, never show a broken/blank page or a
 * client-side crash. Rather than mocking anything, this logs in for real
 * (issuing a real session row + cookie), then does exactly what the gap
 * audit names — "manually expiring a session row" — directly against the
 * database, simulating what a natural 30-day expiry or an admin-side
 * "logout everywhere" would eventually produce, and confirms the next real
 * navigation is turned away cleanly.
 *
 * src/lib/auth/session.ts's getSessionUncached() treats an expired row
 * exactly like a missing one (deletes it and returns null), and every
 * dashboard layout/page is a Server Component that does `if (!session)
 * redirect("/login?next=...")` at the very top — so this is really testing
 * that whole chain end to end through a real browser navigation, not just
 * the one helper function in isolation.
 */

let r: SeededRestaurant;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("expired-session");
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("a session that expires mid-visit redirects to login instead of showing a broken dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator("body")).toContainText("TEST E2E expired-session Restaurant");

  // Manually expire the real session row this login just created — same
  // end state a natural 30-day expiry or a "logout everywhere else" click
  // (destroyOtherSessions/destroyAllSessions in session.ts) leaves behind.
  await expireSessionForUser(r.ownerId);

  // The browser still holds the (now-stale) session cookie — nothing
  // client-side told it anything changed. The very next real navigation
  // must be the thing that catches this, cleanly.
  await page.goto("/dashboard/orders");
  await expect(page).toHaveURL(/\/login/);
  // A real login form, not an error page/stack trace — the "not a broken
  // page" half of this test.
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();

  // The expired session must not silently keep working for a DIFFERENT
  // dashboard route either (confirms this is a session-wide check in the
  // shared layout, not a one-off guard on a single page).
  await page.goto("/dashboard/staff");
  await expect(page).toHaveURL(/\/login/);
});
