/**
 * Platform Control Center (Phase 9) — Support tooling. Integration tests
 * for the DB-backed pieces: internal notes CRUD (scoped delete),
 * status-tag CRUD (idempotent add via the unique index, scoped delete),
 * and getRestaurantHealthScore's signal-gathering (order recency/volume
 * feeding the pure computeHealthScore rubric correctly).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Support tooling (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let notesDb: typeof import("@/lib/support/notes-db");
  let tagsDb: typeof import("@/lib/support/tags-db");
  let getRestaurantHealthScore: typeof import("@/lib/support/health-score-db").getRestaurantHealthScore;

  let restaurantId: string;
  let adminUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    notesDb = await import("@/lib/support/notes-db");
    tagsDb = await import("@/lib/support/tags-db");
    ({ getRestaurantHealthScore } = await import("@/lib/support/health-score-db"));

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-support-tooling-${suffix}`, name: "TEST Support Tooling Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [admin] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Support Admin", phone: `9793${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  });

  describe("support notes", () => {
    it("adds a note and lists it newest-first with the author's name resolved", async () => {
      const first = await notesDb.addSupportNote({
        restaurantId,
        authorUserId: adminUserId,
        note: "TEST first note",
      });
      // Ensure a distinct createdAt ordering.
      await new Promise((r) => setTimeout(r, 10));
      const second = await notesDb.addSupportNote({
        restaurantId,
        authorUserId: adminUserId,
        note: "TEST second note",
      });

      const notes = await notesDb.listSupportNotes(restaurantId);
      const ids = notes.map((n) => n.id);
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      const found = notes.find((n) => n.id === first.id);
      expect(found?.authorFullName).toBe("TEST Support Admin");
      expect(found?.note).toBe("TEST first note");
    });

    it("deleteSupportNote only deletes when the restaurantId matches, and is idempotent-safe (false on a second delete)", async () => {
      const created = await notesDb.addSupportNote({
        restaurantId,
        authorUserId: adminUserId,
        note: "TEST scoped delete",
      });

      const suffix = Math.random().toString(36).slice(2, 8);
      const [otherRestaurant] = await db
        .insert(schema.restaurants)
        .values({ slug: `test-support-other-${suffix}`, name: "TEST Other Restaurant" })
        .returning({ id: schema.restaurants.id });

      const wrongScopeResult = await notesDb.deleteSupportNote(created.id, otherRestaurant.id);
      expect(wrongScopeResult).toBe(false);

      const correctScopeResult = await notesDb.deleteSupportNote(created.id, restaurantId);
      expect(correctScopeResult).toBe(true);

      const secondAttempt = await notesDb.deleteSupportNote(created.id, restaurantId);
      expect(secondAttempt).toBe(false);

      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurant.id));
    });
  });

  describe("support tags", () => {
    it("adds a tag and lists it", async () => {
      await tagsDb.addSupportTag({ restaurantId, addedByUserId: adminUserId, tag: "vip" });
      const tags = await tagsDb.listSupportTags(restaurantId);
      expect(tags.map((t) => t.tag)).toContain("vip");
    });

    it("adding the same tag twice is idempotent (unique index absorbed, no error, no duplicate row)", async () => {
      await tagsDb.addSupportTag({ restaurantId, addedByUserId: adminUserId, tag: "escalated" });
      await tagsDb.addSupportTag({ restaurantId, addedByUserId: adminUserId, tag: "escalated" });

      const tags = await tagsDb.listSupportTags(restaurantId);
      expect(tags.filter((t) => t.tag === "escalated")).toHaveLength(1);
    });

    it("removeSupportTag only removes when the restaurantId matches", async () => {
      await tagsDb.addSupportTag({ restaurantId, addedByUserId: adminUserId, tag: "churn_risk" });
      const tags = await tagsDb.listSupportTags(restaurantId);
      const tagRow = tags.find((t) => t.tag === "churn_risk");
      expect(tagRow).toBeDefined();

      const suffix = Math.random().toString(36).slice(2, 8);
      const [otherRestaurant] = await db
        .insert(schema.restaurants)
        .values({ slug: `test-support-other2-${suffix}`, name: "TEST Other Restaurant 2" })
        .returning({ id: schema.restaurants.id });

      const wrongScope = await tagsDb.removeSupportTag(tagRow!.id, otherRestaurant.id);
      expect(wrongScope).toBe(false);

      const correctScope = await tagsDb.removeSupportTag(tagRow!.id, restaurantId);
      expect(correctScope).toBe(true);

      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurant.id));
    });
  });

  describe("restaurant support notes/tags are cascade-deleted with their restaurant", () => {
    it("deleting the restaurant removes its notes and tags", async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const [scratch] = await db
        .insert(schema.restaurants)
        .values({ slug: `test-support-cascade-${suffix}`, name: "TEST Support Cascade Restaurant" })
        .returning({ id: schema.restaurants.id });

      const note = await notesDb.addSupportNote({
        restaurantId: scratch.id,
        authorUserId: adminUserId,
        note: "TEST cascade note",
      });
      await tagsDb.addSupportTag({ restaurantId: scratch.id, addedByUserId: adminUserId, tag: "new" });

      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, scratch.id));

      const remainingNotes = await db
        .select({ id: schema.restaurantSupportNotes.id })
        .from(schema.restaurantSupportNotes)
        .where(eq(schema.restaurantSupportNotes.id, note.id));
      expect(remainingNotes).toHaveLength(0);

      const remainingTags = await db
        .select({ id: schema.restaurantSupportTags.id })
        .from(schema.restaurantSupportTags)
        .where(eq(schema.restaurantSupportTags.restaurantId, scratch.id));
      expect(remainingTags).toHaveLength(0);
    });
  });

  describe("getRestaurantHealthScore", () => {
    it("throws for a restaurant that doesn't exist", async () => {
      await expect(
        getRestaurantHealthScore("00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("Restaurant not found.");
    });

    it("a suspended restaurant with no orders scores low and lists both reasons", async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const [scratch] = await db
        .insert(schema.restaurants)
        .values({
          slug: `test-support-health-${suffix}`,
          name: "TEST Support Health Restaurant",
          isActive: false,
          subscriptionStatus: "active",
          // Onboarded well outside the grace period so "no orders" counts.
          onboardingCompletedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: schema.restaurants.id });

      const result = await getRestaurantHealthScore(scratch.id);
      expect(result.reasons.map((r) => r.label)).toEqual(
        expect.arrayContaining(["Restaurant is suspended", "No orders placed yet"]),
      );
      expect(result.band).not.toBe("healthy");

      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, scratch.id));
    });

    it("a healthy, active, well-onboarded restaurant with no orders yet (within grace period) scores 100", async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const [scratch] = await db
        .insert(schema.restaurants)
        .values({
          slug: `test-support-health-fresh-${suffix}`,
          name: "TEST Support Health Fresh Restaurant",
          isActive: true,
          subscriptionStatus: "trialing",
          trialEndsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
          onboardingCompletedAt: new Date(),
        })
        .returning({ id: schema.restaurants.id });

      const result = await getRestaurantHealthScore(scratch.id);
      expect(result.score).toBe(100);
      expect(result.band).toBe("healthy");

      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, scratch.id));
    });
  });
});
