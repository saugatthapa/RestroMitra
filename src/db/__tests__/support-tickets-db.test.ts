/**
 * Gap audit P1 — restaurant-owner-facing support tickets. Integration
 * tests for the DB-backed pieces in src/lib/support/tickets-db.ts:
 * tenant isolation (a restaurant can never see or reply to another
 * restaurant's ticket), the full create -> reply -> resolve flow, the
 * admin-side cross-tenant listing/filtering, and — mirroring
 * platform-authorization.test.ts's own convention, since there is no
 * session-mocking harness for API route handlers in this codebase yet —
 * that MANAGE_SUPPORT (the permission every /api/admin/support-tickets/*
 * route is gated on) is granted to support_admin/platform_admin and
 * denied to a role with no platform grant at all.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as
 * every other DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Support tickets (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ticketsDb: typeof import("@/lib/support/tickets-db");
  let roleHasPlatformPermission: typeof import("@/lib/rbac/platform-permissions").roleHasPlatformPermission;
  let PLATFORM_PERMISSIONS: typeof import("@/lib/rbac/platform-permissions").PLATFORM_PERMISSIONS;

  let restaurantAId: string;
  let restaurantBId: string;
  let ownerAId: string;
  let ownerBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ticketsDb = await import("@/lib/support/tickets-db");
    ({ roleHasPlatformPermission, PLATFORM_PERMISSIONS } = await import(
      "@/lib/rbac/platform-permissions"
    ));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tickets-a-${suffix}`, name: "TEST Tickets Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tickets-b-${suffix}`, name: "TEST Tickets Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Owner A", phone: `9781${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Owner B", phone: `9782${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    ownerBId = ownerB.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(inArray(schema.restaurants.id, [restaurantAId, restaurantBId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [ownerAId, ownerBId]));
  });

  describe("create -> reply -> resolve flow", () => {
    it("files a ticket with its opening message, accepts replies from both sides, and can be marked resolved", async () => {
      const created = await ticketsDb.createSupportTicket({
        restaurantId: restaurantAId,
        createdByUserId: ownerAId,
        subject: "TEST Printer not connecting",
        body: "TEST The KOT printer stopped printing this morning.",
      });
      expect(created.id).toBeTruthy();

      const afterCreate = await ticketsDb.getSupportTicketForRestaurant(created.id, restaurantAId);
      expect(afterCreate?.status).toBe("open");
      expect(afterCreate?.priority).toBe("normal");
      expect(afterCreate?.createdByFullName).toBe("TEST Owner A");

      const messagesAfterCreate = await ticketsDb.listSupportTicketMessages(created.id);
      expect(messagesAfterCreate).toHaveLength(1);
      expect(messagesAfterCreate[0].isFromPlatform).toBe(false);
      expect(messagesAfterCreate[0].body).toContain("KOT printer");

      // A platform admin (represented here just by isFromPlatform: true —
      // authorUserId is any real user id, per the schema's own comment)
      // replies on the thread.
      await ticketsDb.addSupportTicketMessage({
        ticketId: created.id,
        authorUserId: ownerAId,
        isFromPlatform: true,
        body: "TEST Can you share the printer model?",
      });

      // The tenant replies back.
      await new Promise((r) => setTimeout(r, 10));
      await ticketsDb.addSupportTicketMessage({
        ticketId: created.id,
        authorUserId: ownerAId,
        isFromPlatform: false,
        body: "TEST It's an Epson TM-T88VI.",
      });

      const thread = await ticketsDb.listSupportTicketMessages(created.id);
      expect(thread).toHaveLength(3);
      expect(thread.map((m) => m.isFromPlatform)).toEqual([false, true, false]);

      // Replying bumped updatedAt without reopening/changing status.
      const afterReplies = await ticketsDb.getSupportTicketForRestaurant(created.id, restaurantAId);
      expect(afterReplies?.status).toBe("open");
      expect(afterReplies!.updatedAt.getTime()).toBeGreaterThan(afterCreate!.updatedAt.getTime());

      const resolved = await ticketsDb.updateSupportTicketStatus(created.id, "resolved");
      expect(resolved?.id).toBe(created.id);
      expect(resolved?.restaurantId).toBe(restaurantAId);

      const final = await ticketsDb.getSupportTicketForRestaurant(created.id, restaurantAId);
      expect(final?.status).toBe("resolved");
    });

    it("updateSupportTicketStatus returns null for a ticket that doesn't exist", async () => {
      const result = await ticketsDb.updateSupportTicketStatus(
        "00000000-0000-0000-0000-000000000000",
        "closed",
      );
      expect(result).toBeNull();
    });
  });

  describe("tenant isolation", () => {
    it("a restaurant's ticket list never includes another restaurant's tickets", async () => {
      const ticketA = await ticketsDb.createSupportTicket({
        restaurantId: restaurantAId,
        createdByUserId: ownerAId,
        subject: "TEST A-only ticket",
        body: "TEST body A",
      });
      const ticketB = await ticketsDb.createSupportTicket({
        restaurantId: restaurantBId,
        createdByUserId: ownerBId,
        subject: "TEST B-only ticket",
        body: "TEST body B",
      });

      const listA = await ticketsDb.listSupportTicketsForRestaurant(restaurantAId);
      expect(listA.map((t) => t.id)).toContain(ticketA.id);
      expect(listA.map((t) => t.id)).not.toContain(ticketB.id);

      const listB = await ticketsDb.listSupportTicketsForRestaurant(restaurantBId);
      expect(listB.map((t) => t.id)).toContain(ticketB.id);
      expect(listB.map((t) => t.id)).not.toContain(ticketA.id);
    });

    it("getSupportTicketForRestaurant returns null when the ticket belongs to a different restaurant (the tenant-isolation boundary a route relies on before allowing a reply)", async () => {
      const ticketA = await ticketsDb.createSupportTicket({
        restaurantId: restaurantAId,
        createdByUserId: ownerAId,
        subject: "TEST cross-tenant read guard",
        body: "TEST body",
      });

      const wrongScope = await ticketsDb.getSupportTicketForRestaurant(ticketA.id, restaurantBId);
      expect(wrongScope).toBeNull();

      const correctScope = await ticketsDb.getSupportTicketForRestaurant(ticketA.id, restaurantAId);
      expect(correctScope?.id).toBe(ticketA.id);
    });

    it("a ticket is cascade-deleted (with its messages) when its restaurant is deleted", async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const [scratch] = await db
        .insert(schema.restaurants)
        .values({ slug: `test-tickets-cascade-${suffix}`, name: "TEST Tickets Cascade Restaurant" })
        .returning({ id: schema.restaurants.id });

      const ticket = await ticketsDb.createSupportTicket({
        restaurantId: scratch.id,
        createdByUserId: ownerAId,
        subject: "TEST cascade ticket",
        body: "TEST cascade body",
      });

      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, scratch.id));

      const remainingTicket = await db
        .select({ id: schema.supportTickets.id })
        .from(schema.supportTickets)
        .where(eq(schema.supportTickets.id, ticket.id));
      expect(remainingTicket).toHaveLength(0);

      const remainingMessages = await db
        .select({ id: schema.supportTicketMessages.id })
        .from(schema.supportTicketMessages)
        .where(eq(schema.supportTicketMessages.ticketId, ticket.id));
      expect(remainingMessages).toHaveLength(0);
    });
  });

  describe("admin cross-tenant listing", () => {
    it("listAllSupportTickets sees tickets across every restaurant and can narrow to one restaurant or one status", async () => {
      const ticketA = await ticketsDb.createSupportTicket({
        restaurantId: restaurantAId,
        createdByUserId: ownerAId,
        subject: "TEST admin-visible A",
        body: "TEST body",
      });
      const ticketB = await ticketsDb.createSupportTicket({
        restaurantId: restaurantBId,
        createdByUserId: ownerBId,
        subject: "TEST admin-visible B",
        body: "TEST body",
      });
      await ticketsDb.updateSupportTicketStatus(ticketB.id, "closed");

      const all = await ticketsDb.listAllSupportTickets({ limit: 200 });
      const allIds = all.tickets.map((t) => t.id);
      expect(allIds).toContain(ticketA.id);
      expect(allIds).toContain(ticketB.id);

      const scopedToA = await ticketsDb.listAllSupportTickets({ restaurantId: restaurantAId });
      expect(scopedToA.tickets.every((t) => t.restaurantId === restaurantAId)).toBe(true);
      expect(scopedToA.tickets.map((t) => t.id)).toContain(ticketA.id);
      expect(scopedToA.tickets.map((t) => t.id)).not.toContain(ticketB.id);

      const closedOnly = await ticketsDb.listAllSupportTickets({ status: "closed", limit: 200 });
      expect(closedOnly.tickets.map((t) => t.id)).toContain(ticketB.id);
      expect(closedOnly.tickets.every((t) => t.status === "closed")).toBe(true);
    });

    it("getSupportTicketAdmin resolves a ticket by id alone, including its restaurant's name", async () => {
      const ticketA = await ticketsDb.createSupportTicket({
        restaurantId: restaurantAId,
        createdByUserId: ownerAId,
        subject: "TEST admin single lookup",
        body: "TEST body",
      });

      const found = await ticketsDb.getSupportTicketAdmin(ticketA.id);
      expect(found?.restaurantId).toBe(restaurantAId);
      expect(found?.restaurantName).toBe("TEST Tickets Restaurant A");

      const missing = await ticketsDb.getSupportTicketAdmin("00000000-0000-0000-0000-000000000000");
      expect(missing).toBeNull();
    });
  });

  describe("MANAGE_SUPPORT gates the admin support-ticket routes", () => {
    it("support_admin and the full-access tiers hold MANAGE_SUPPORT; a narrower role does not", () => {
      expect(roleHasPlatformPermission("support_admin", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(true);
      expect(roleHasPlatformPermission("platform_admin", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(true);
      expect(roleHasPlatformPermission("super_admin", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(true);
      expect(roleHasPlatformPermission("billing_admin", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(false);
      expect(roleHasPlatformPermission("platform_viewer", PLATFORM_PERMISSIONS.MANAGE_SUPPORT)).toBe(false);
    });
  });
});
