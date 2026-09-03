import "server-only";
import { eq } from "drizzle-orm";
import type { Database } from "@/db";
import { restaurants, branches, userRoles } from "@/db/schema";
import { recordSubscriptionEvent } from "@/lib/subscription-db";
import { seedDefaultExpenseCategories } from "@/lib/expense-categories";
import { slugify, randomSuffix } from "@/lib/slug";
import { isUniqueViolation } from "@/lib/db-error";
import type { restaurantTypes } from "@/lib/validation/onboarding";

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type CreateRestaurantOnboardingInput = {
  name: string;
  type: (typeof restaurantTypes)[number];
  address: string;
  city: string;
  district: string;
  phone: string;
  panVat?: string | null;
  logoUrl?: string | null;
  openTime: string;
  closeTime: string;
  ownerUserId: string;
};

/**
 * Creates a brand-new restaurant + its main branch + the caller's owner
 * grant + trial subscription event + default expense categories, all in
 * one transaction, with a slug picked from the restaurant's name.
 *
 * QA hardening pass (onboarding-race audit) — extracted out of the route
 * handler specifically so the slug-collision retry could be given a real
 * concurrency test (same "test the lib function directly against a real
 * DB" convention as table-operations.ts/combos.ts/bill-splits.ts; RBAC
 * itself is out of scope here since this only ever runs for an already
 * -authenticated caller, checked by the route before this is called).
 *
 * The up-front `slugify(name)` collision check is a genuine TOCTOU race:
 * two people signing up with the same restaurant name at nearly the same
 * moment can both see "not taken" before either commits. Without a retry,
 * the loser's INSERT hits `restaurants_slug_unique` and the whole request
 * would fail with a raw, unhandled DB error instead of just falling back
 * to a suffixed slug the way an OFFLINE collision already does. Each
 * retry re-suffixes and re-runs the WHOLE transaction — db.transaction()
 * rolls a failed attempt back completely before the next one starts, so a
 * partial restaurant/branch/owner-grant is never left behind.
 */
export async function createRestaurantOnboarding(
  db: Database,
  input: CreateRestaurantOnboardingInput,
): Promise<{ restaurant: { id: string; slug: string }; branch: { id: string } }> {
  const baseSlug = slugify(input.name) || "restaurant";
  let slug = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const collision = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.slug, slug))
      .limit(1);
    if (collision.length === 0) break;
    slug = `${baseSlug}-${randomSuffix()}`;
  }

  const openingHours = Object.fromEntries(
    DAYS.map((day) => [day, { open: input.openTime, close: input.closeTime }]),
  );

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 30);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [restaurant] = await tx
          .insert(restaurants)
          .values({
            slug,
            name: input.name,
            type: input.type,
            address: input.address,
            city: input.city,
            district: input.district,
            phone: input.phone,
            panVat: input.panVat && input.panVat.length > 0 ? input.panVat : null,
            logoUrl: input.logoUrl && input.logoUrl.length > 0 ? input.logoUrl : null,
            openingHours,
            onboardingStep: 8,
            subscriptionStatus: "trialing",
            trialEndsAt,
            // No payment gateway is integrated yet, so this self-serve
            // signup path is the one place that explicitly opts a new
            // restaurant OUT of the verified-by-default state (see
            // restaurants.verifiedAt's own schema comment) — the owner
            // hits /verify-account right after this, until a platform
            // admin confirms them via WhatsApp/Instagram/TikTok.
            verifiedAt: null,
          })
          .returning({ id: restaurants.id, slug: restaurants.slug });

        const [branch] = await tx
          .insert(branches)
          .values({
            restaurantId: restaurant.id,
            name: `${input.name} — Main Branch`,
            address: input.address,
            city: input.city,
            phone: input.phone,
            isMain: true,
          })
          .returning({ id: branches.id });

        await tx.insert(userRoles).values({
          userId: input.ownerUserId,
          restaurantId: restaurant.id,
          branchId: null, // owner: unrestricted across all branches
          role: "owner",
        });

        await recordSubscriptionEvent(tx, {
          restaurantId: restaurant.id,
          eventType: "trial_started",
          toStatus: "trialing",
          note: "30-day free trial started at signup.",
          performedByUserId: input.ownerUserId,
        });

        await seedDefaultExpenseCategories(tx, restaurant.id);

        return { restaurant, branch };
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) {
        slug = `${baseSlug}-${randomSuffix()}`;
        continue;
      }
      throw err;
    }
  }
  // Unreachable in practice (the loop either returns or throws on its
  // last attempt), but keeps the function's return type honest.
  throw new Error("Could not create restaurant: slug collision retries exhausted.");
}
