/**
 * Gap-audit P2 fix (fiscal compliance): integration coverage for the
 * PAN/VAT round-trip the tax-settings route (src/app/api/restaurants/
 * [slug]/tax-settings/route.ts) performs. That route is a thin,
 * session/permission-gated wrapper around exactly the DB read/write below
 * — same "empty string clears the field back to null" conversion on PATCH,
 * same plain select on GET — so this exercises the actual persistence
 * behavior an owner relies on when saving from FiscalSettingsPanel,
 * without needing to fake a signed-in session (no test in this codebase
 * calls an authenticated restaurant-scoped route handler directly; DB-level
 * coverage of the route's own logic is the established pattern here — see
 * e.g. onboarding.test.ts for the same shape applied to panVat).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("tax-settings route persistence (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  const createdRestaurantIds: string[] = [];

  async function createRestaurant() {
    if (!db) db = (await import("@/db")).db;
    if (!schema) schema = await import("@/db/schema");
    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tax-settings-${suffix}`, name: "TEST Tax Settings Restaurant" })
      .returning({ id: schema.restaurants.id });
    createdRestaurantIds.push(restaurant.id);
    return restaurant.id;
  }

  // Mirrors the route's PATCH handler exactly: trim, then empty-string
  // means "clear back to null" rather than "save an empty string".
  function toNextValue(input: string) {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async function saveTaxSettings(restaurantId: string, panNumber: string, vatNumber: string) {
    const [updated] = await db
      .update(schema.restaurants)
      .set({
        panNumber: toNextValue(panNumber),
        vatNumber: toNextValue(vatNumber),
        updatedAt: new Date(),
      })
      .where(eq(schema.restaurants.id, restaurantId))
      .returning({ panNumber: schema.restaurants.panNumber, vatNumber: schema.restaurants.vatNumber });
    return updated;
  }

  async function readTaxSettings(restaurantId: string) {
    const [row] = await db
      .select({ panNumber: schema.restaurants.panNumber, vatNumber: schema.restaurants.vatNumber })
      .from(schema.restaurants)
      .where(eq(schema.restaurants.id, restaurantId))
      .limit(1);
    return { panNumber: row?.panNumber ?? null, vatNumber: row?.vatNumber ?? null };
  }

  afterAll(async () => {
    if (!db || !schema || createdRestaurantIds.length === 0) return;
    const { inArray } = await import("drizzle-orm");
    await db.delete(schema.restaurants).where(inArray(schema.restaurants.id, createdRestaurantIds));
  });

  it("a brand-new restaurant has null PAN and VAT (never a placeholder)", async () => {
    const restaurantId = await createRestaurant();
    expect(await readTaxSettings(restaurantId)).toEqual({ panNumber: null, vatNumber: null });
  });

  it("saving both fields round-trips exactly through a save + fresh read", async () => {
    const restaurantId = await createRestaurant();
    const saved = await saveTaxSettings(restaurantId, "301234567", "301234567V");
    expect(saved).toEqual({ panNumber: "301234567", vatNumber: "301234567V" });

    const read = await readTaxSettings(restaurantId);
    expect(read).toEqual({ panNumber: "301234567", vatNumber: "301234567V" });
  });

  it("saving PAN alone leaves VAT null (the common case — most restaurants aren't VAT-registered)", async () => {
    const restaurantId = await createRestaurant();
    await saveTaxSettings(restaurantId, "301234567", "");
    expect(await readTaxSettings(restaurantId)).toEqual({ panNumber: "301234567", vatNumber: null });
  });

  it("re-saving with an empty string clears a previously-set value back to null", async () => {
    const restaurantId = await createRestaurant();
    await saveTaxSettings(restaurantId, "301234567", "301234567V");
    expect(await readTaxSettings(restaurantId)).toEqual({
      panNumber: "301234567",
      vatNumber: "301234567V",
    });

    await saveTaxSettings(restaurantId, "301234567", "");
    expect(await readTaxSettings(restaurantId)).toEqual({ panNumber: "301234567", vatNumber: null });
  });

  it("is independent of the older freeform panVat column captured at onboarding", async () => {
    const restaurantId = await createRestaurant();
    await db
      .update(schema.restaurants)
      .set({ panVat: "PAN: 999999999 (legacy onboarding value)" })
      .where(eq(schema.restaurants.id, restaurantId));

    // Setting the new structured fields must not touch, and must not be
    // affected by, the legacy field.
    await saveTaxSettings(restaurantId, "301234567", "301234567V");
    const [row] = await db
      .select({
        panVat: schema.restaurants.panVat,
        panNumber: schema.restaurants.panNumber,
        vatNumber: schema.restaurants.vatNumber,
      })
      .from(schema.restaurants)
      .where(eq(schema.restaurants.id, restaurantId))
      .limit(1);
    expect(row.panVat).toBe("PAN: 999999999 (legacy onboarding value)");
    expect(row.panNumber).toBe("301234567");
    expect(row.vatNumber).toBe("301234567V");
  });
});
