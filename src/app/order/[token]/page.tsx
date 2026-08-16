import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables, restaurants } from "@/db/schema";
import { PublicOrderMenu } from "./PublicOrderMenu";

/**
 * Public, unauthenticated customer-facing page — reached by scanning a
 * table's QR code. No session/login involved anywhere in this flow; the
 * qrToken itself IS the access control (high-entropy, resolved server-side
 * to exactly one table). See src/app/api/order/[token]/route.ts for the
 * matching submission endpoint and why that's safe to expose publicly.
 */
export default async function PublicOrderPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const rows = await db
    .select({
      tableId: restaurantTables.id,
      tableName: restaurantTables.name,
      tableIsActive: restaurantTables.isActive,
      restaurantId: restaurants.id,
      restaurantName: restaurants.name,
      restaurantIsActive: restaurants.isActive,
    })
    .from(restaurantTables)
    .innerJoin(restaurants, eq(restaurantTables.restaurantId, restaurants.id))
    .where(eq(restaurantTables.qrToken, token))
    .limit(1);

  const resolved = rows[0];
  if (!resolved) notFound();

  if (!resolved.tableIsActive || !resolved.restaurantIsActive) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-6 text-center">
        <div>
          <p className="text-lg font-semibold text-neutral-900">Table unavailable</p>
          <p className="mt-2 text-sm text-neutral-500">
            This table isn&apos;t currently accepting orders. Please ask staff for help.
          </p>
        </div>
      </div>
    );
  }

  const categories = await db.query.categories.findMany({
    where: (c, { eq: eqC, and: andC }) =>
      andC(eqC(c.restaurantId, resolved.restaurantId), eqC(c.isActive, true)),
    orderBy: (c, { asc }) => [asc(c.sortOrder)],
    with: {
      menuItems: {
        where: (mi, { eq: eqM, and: andM }) => andM(eqM(mi.isActive, true), eqM(mi.isAvailable, true)),
        orderBy: (mi, { asc }) => [asc(mi.sortOrder)],
        with: {
          variants: {
            where: (v, { eq: eqV }) => eqV(v.isActive, true),
            orderBy: (v, { asc }) => [asc(v.sortOrder)],
          },
          addons: {
            where: (a, { eq: eqA }) => eqA(a.isAvailable, true),
            orderBy: (a, { asc }) => [asc(a.sortOrder)],
          },
        },
      },
    },
  });

  // Categories with nothing currently orderable in them just add clutter
  // to a customer's menu — hide, don't show an empty section.
  const categoriesWithItems = categories.filter((c) => c.menuItems.length > 0);

  return (
    <PublicOrderMenu
      token={token}
      restaurantName={resolved.restaurantName}
      tableName={resolved.tableName}
      categories={categoriesWithItems}
    />
  );
}
