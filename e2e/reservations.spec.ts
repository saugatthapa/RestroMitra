import { test, expect } from "@playwright/test";
import { seedOwnerRestaurant, teardownRestaurant, E2E_PASSWORD, type SeededRestaurant } from "./db";

/**
 * Highest-value flow #4: staff creating a table reservation from the
 * dashboard. This is the flow the P0-6 timezone fix (restaurantStartOfDay
 * in src/lib/tables.ts) exists to protect — a UTC-vs-restaurant-timezone
 * bug there would silently show/hide "today's" reservations at the wrong
 * boundary, which only an actual browser round trip against the real
 * clock (not a unit test with a fixed Date) would catch in the same way a
 * real user would experience it.
 */

let r: SeededRestaurant;

test.beforeAll(async () => {
  r = await seedOwnerRestaurant("reservations");
});

test.afterAll(async () => {
  await teardownRestaurant(r);
});

test("owner can create a reservation and see it listed", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("98XXXXXXXX").fill(r.ownerPhone);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/reservations");

  await page.getByRole("button", { name: "+ New reservation" }).click();

  const customerName = `TEST Reservation Guest ${Date.now()}`;
  await page.getByLabel("Name").fill(customerName);
  await page.getByLabel("Phone").fill("9812345678");
  await page.getByLabel("Party size").fill("4");
  // Date & time input already defaults to today at 19:00 (see AddReservationForm's
  // `defaultDate` — leaving it as-is exercises the common case, a same-day
  // booking, which is exactly what the restaurant-timezone "today" boundary
  // fix affects).

  await page.getByRole("button", { name: "Create reservation" }).click();

  // The form clears customerName/customerPhone and calls onAdded() on
  // success (see ReservationsBoard.tsx) — the concrete proof of success is
  // the new reservation actually showing up in the list below, not just
  // the form going quiet.
  await expect(page.locator("body")).toContainText(customerName);
});
