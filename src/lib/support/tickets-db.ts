import "server-only";
import { and, desc, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { supportTickets, supportTicketMessages, users, restaurants } from "@/db/schema";

export type SupportTicketStatus = "open" | "in_progress" | "resolved" | "closed";
export type SupportTicketPriority = "low" | "normal" | "high";

export type SupportTicketSummary = {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  createdByFullName: string | null;
};

export type SupportTicketAdminSummary = SupportTicketSummary & {
  restaurantId: string;
  restaurantName: string;
};

export type SupportTicketMessageRow = {
  id: string;
  ticketId: string;
  body: string;
  isFromPlatform: boolean;
  createdAt: Date;
  authorUserId: string | null;
  authorFullName: string | null;
};

const TICKET_LIST_LIMIT = 100;
const ADMIN_TICKET_LIST_DEFAULT_LIMIT = 50;
const ADMIN_TICKET_LIST_MAX_LIMIT = 200;

const TICKET_SUMMARY_COLUMNS = {
  id: supportTickets.id,
  subject: supportTickets.subject,
  status: supportTickets.status,
  priority: supportTickets.priority,
  createdAt: supportTickets.createdAt,
  updatedAt: supportTickets.updatedAt,
  createdByUserId: supportTickets.createdByUserId,
  createdByFullName: users.fullName,
};

/**
 * Files a new ticket AND its opening message in one transaction — a ticket
 * with zero messages would be a dead end in the UI (the thread view has
 * nothing to show), so the two inserts always happen together, never one
 * without the other.
 */
export async function createSupportTicket(params: {
  restaurantId: string;
  createdByUserId: string;
  subject: string;
  body: string;
  priority?: SupportTicketPriority;
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .insert(supportTickets)
      .values({
        restaurantId: params.restaurantId,
        createdByUserId: params.createdByUserId,
        subject: params.subject,
        priority: params.priority ?? "normal",
      })
      .returning({ id: supportTickets.id });

    await tx.insert(supportTicketMessages).values({
      ticketId: ticket.id,
      authorUserId: params.createdByUserId,
      isFromPlatform: false,
      body: params.body,
    });

    return ticket;
  });
}

/** Tenant-side listing — always scoped to one restaurant. Newest activity first. */
export async function listSupportTicketsForRestaurant(
  restaurantId: string,
  opts: { status?: SupportTicketStatus } = {},
): Promise<SupportTicketSummary[]> {
  const conditions = [eq(supportTickets.restaurantId, restaurantId)];
  if (opts.status) conditions.push(eq(supportTickets.status, opts.status));

  const rows = await db
    .select(TICKET_SUMMARY_COLUMNS)
    .from(supportTickets)
    .leftJoin(users, eq(supportTickets.createdByUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(supportTickets.updatedAt))
    .limit(TICKET_LIST_LIMIT);
  return rows;
}

/**
 * Scoped to (id, restaurantId) together — same "never trust an id alone"
 * convention as deleteSupportNote/removeSupportTag above — so a tenant
 * route can never read (or, transitively, reply to) a ticket that
 * belongs to a DIFFERENT restaurant just by guessing its id. Returns null
 * on any mismatch; the route treats that identically to "not found".
 */
export async function getSupportTicketForRestaurant(
  id: string,
  restaurantId: string,
): Promise<SupportTicketSummary | null> {
  const [row] = await db
    .select(TICKET_SUMMARY_COLUMNS)
    .from(supportTickets)
    .leftJoin(users, eq(supportTickets.createdByUserId, users.id))
    .where(and(eq(supportTickets.id, id), eq(supportTickets.restaurantId, restaurantId)))
    .limit(1);
  return row ?? null;
}

/** Admin-side: unscoped lookup by id alone (a platform admin may view any tenant's ticket). */
export async function getSupportTicketAdmin(id: string): Promise<SupportTicketAdminSummary | null> {
  const [row] = await db
    .select({ ...TICKET_SUMMARY_COLUMNS, restaurantId: supportTickets.restaurantId, restaurantName: restaurants.name })
    .from(supportTickets)
    .leftJoin(users, eq(supportTickets.createdByUserId, users.id))
    .innerJoin(restaurants, eq(supportTickets.restaurantId, restaurants.id))
    .where(eq(supportTickets.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Admin-side: every ticket across every tenant, newest activity first,
 * optionally narrowed to a status and/or a single restaurant (mirrors
 * listPlatformAuditLogs' optional-restaurantId shape in audit.ts). Fetches
 * one extra row beyond `limit` to report `hasMore` without a separate
 * COUNT(*), same convention as listAuditLogs/listPlatformAuditLogs.
 */
export async function listAllSupportTickets(
  opts: {
    status?: SupportTicketStatus;
    restaurantId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ tickets: SupportTicketAdminSummary[]; hasMore: boolean; limit: number; offset: number }> {
  const limit = Math.min(
    ADMIN_TICKET_LIST_MAX_LIMIT,
    Math.max(1, opts.limit ?? ADMIN_TICKET_LIST_DEFAULT_LIMIT),
  );
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [];
  if (opts.status) conditions.push(eq(supportTickets.status, opts.status));
  if (opts.restaurantId) conditions.push(eq(supportTickets.restaurantId, opts.restaurantId));

  const rows = await db
    .select({ ...TICKET_SUMMARY_COLUMNS, restaurantId: supportTickets.restaurantId, restaurantName: restaurants.name })
    .from(supportTickets)
    .leftJoin(users, eq(supportTickets.createdByUserId, users.id))
    .innerJoin(restaurants, eq(supportTickets.restaurantId, restaurants.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(supportTickets.updatedAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  return { tickets: hasMore ? rows.slice(0, limit) : rows, hasMore, limit, offset };
}

/** Every message on a ticket, oldest first (thread reading order). Not itself restaurant-scoped — callers must verify ticket ownership first via getSupportTicketForRestaurant on the tenant side. */
export async function listSupportTicketMessages(ticketId: string): Promise<SupportTicketMessageRow[]> {
  const rows = await db
    .select({
      id: supportTicketMessages.id,
      ticketId: supportTicketMessages.ticketId,
      body: supportTicketMessages.body,
      isFromPlatform: supportTicketMessages.isFromPlatform,
      createdAt: supportTicketMessages.createdAt,
      authorUserId: supportTicketMessages.authorUserId,
      authorFullName: users.fullName,
    })
    .from(supportTicketMessages)
    .leftJoin(users, eq(supportTicketMessages.authorUserId, users.id))
    .where(eq(supportTicketMessages.ticketId, ticketId))
    .orderBy(asc(supportTicketMessages.createdAt));
  return rows;
}

/**
 * Appends a reply and bumps the ticket's updatedAt in one transaction, so
 * "newest activity first" listings (both tenant and admin) reflect a
 * reply the same way they reflect a status change. Replying to a ticket
 * that's been closed/resolved does NOT reopen it — status is a deliberate
 * admin (or, for reopening, tenant-visible) decision, never an implicit
 * side effect of someone adding one more message to the record.
 */
export async function addSupportTicketMessage(params: {
  ticketId: string;
  authorUserId: string;
  isFromPlatform: boolean;
  body: string;
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(supportTicketMessages)
      .values({
        ticketId: params.ticketId,
        authorUserId: params.authorUserId,
        isFromPlatform: params.isFromPlatform,
        body: params.body,
      })
      .returning({ id: supportTicketMessages.id });

    await tx
      .update(supportTickets)
      .set({ updatedAt: new Date() })
      .where(eq(supportTickets.id, params.ticketId));

    return message;
  });
}

/** Admin-only status transition. Returns null if the ticket doesn't exist. */
export async function updateSupportTicketStatus(
  id: string,
  status: SupportTicketStatus,
): Promise<{ id: string; restaurantId: string } | null> {
  const [row] = await db
    .update(supportTickets)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportTickets.id, id))
    .returning({ id: supportTickets.id, restaurantId: supportTickets.restaurantId });
  return row ?? null;
}
