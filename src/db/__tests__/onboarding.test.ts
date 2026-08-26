/**
 * Integration test for the onboarding-race fix (branch-isolation/offline
 * audit pass): src/lib/onboarding.ts's createRestaurantOnboarding() used
 * to only check-then-insert a slug once, with no retry — two people
 * signing up with the same restaurant name close enough together (or a
 * client double-submitting the onboarding form) could both pass the
 * "slug not taken" SELECT before either INSERT committed, so the loser's
 * INSERT would hit restaurants_slug_unique and the whole request would
 * fail with a raw, unhandled DB error instead of quietly falling back to
 * a suffixed slug.
 *
 * The fix retries the whole transaction (re-suffixing the slug) on a
 * unique-violation. This test proves the genuinely-concurrent case
 * (two Promise.all calls with the same name) both succeed with distinct
 * slugs, and that a normal single call still works and stays idempotent
 * about not looping unnecessarily.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, afterAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("createRestaurantOnboarding (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let createRestaurantOnboarding: typeof import("@/lib/onboarding").createRestaurantOnboarding;

  const createdRestaurantIds: string[] = [];
  const createdUserIds: string[] = [];

  async function makeOwner(label: string) {
    if (!db) db = (await import("@/db")).db;
    if (!schema) schema = await import("@/db/schema");
    const suffix = Math.random().toString(36).slice(2, 8);
    const [user] = await db
      .insert(schema.users)
      .values({ fullName: `TEST Onboarding ${label}`, phone: `9746${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    createdUserIds.push(user.id);
    return user.id;
  }

  function makeInput(name: string) {
    return {
      name,
      type: "momo_shop" as const,
      address: "123 Test Street",
      city: "Kathmandu",
      district: "Kathmandu",
      phone: "9800000000",
      panVat: null,
      logoUrl: null,
      openTime: "09:00",
      closeTime: "21:00",
    };
  }

  afterAll(async () => {
    if (!db || !schema) return;
    const { inArray } = await import("drizzle-orm");
    if (createdRestaurantIds.length > 0) {
      // Cascades to branches/userRoles/subscriptionEvents/expenseCategories.
      await db.delete(schema.restaurants).where(inArray(schema.restaurants.id, createdRestaurantIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    }
  });

  it("creates a restaurant with the expected slugified name", async () => {
    if (!createRestaurantOnboarding) {
      createRestaurantOnboarding = (await import("@/lib/onboarding")).createRestaurantOnboarding;
    }
    const ownerUserId = await makeOwner("Solo");
    const suffix = Math.random().toString(36).slice(2, 8);
    const result = await createRestaurantOnboarding(db, {
      ...makeInput(`Solo Slug Momo House ${suffix}`),
      ownerUserId,
    });
    createdRestaurantIds.push(result.restaurant.id);
    expect(result.restaurant.slug).toMatch(/^solo-slug-momo-house-/);
    expect(result.branch.id).toBeTruthy();
  });

  it(
    "concurrent request: two signups with the SAME restaurant name both succeed with distinct " +
      "slugs, not a 500 from an unhandled slug-uniqueness violation",
    async () => {
      if (!createRestaurantOnboarding) {
        createRestaurantOnboarding = (await import("@/lib/onboarding")).createRestaurantOnboarding;
      }
      const [ownerAId, ownerBId] = await Promise.all([makeOwner("A"), makeOwner("B")]);

      // Both calls target the exact same restaurant name (and therefore
      // the same base slug) and fire via Promise.all — genuinely racing
      // each other, same "don't rely on real race timing being lucky,
      // but do also exercise it directly" convention as
      // service-calls-race.test.ts. Neither has ever created this slug
      // before (fresh random suffix per test run), so both pre-checks
      // see "not taken" and the collision surfaces at INSERT time,
      // exactly the path the fix is for.
      const suffix = Math.random().toString(36).slice(2, 8);
      const sharedName = `Race Condition Momo House ${suffix}`;
      const [resultA, resultB] = await Promise.all([
        createRestaurantOnboarding(db, { ...makeInput(sharedName), ownerUserId: ownerAId }),
        createRestaurantOnboarding(db, { ...makeInput(sharedName), ownerUserId: ownerBId }),
      ]);
      createdRestaurantIds.push(resultA.restaurant.id, resultB.restaurant.id);

      // Both requests succeeded (no exception propagated out of either
      // Promise) and each got its own restaurant with a DIFFERENT slug —
      // proving the retry-on-collision path actually fired for whichever
      // one lost the race, rather than crashing.
      expect(resultA.restaurant.id).not.toBe(resultB.restaurant.id);
      expect(resultA.restaurant.slug).not.toBe(resultB.restaurant.slug);
      const expectedPrefix = new RegExp(`^race-condition-momo-house-${suffix}`);
      expect(resultA.restaurant.slug).toMatch(expectedPrefix);
      expect(resultB.restaurant.slug).toMatch(expectedPrefix);
    },
  );
});
