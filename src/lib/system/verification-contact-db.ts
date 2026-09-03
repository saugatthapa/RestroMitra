import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformVerificationContact, users } from "@/db/schema";

export type VerificationContact = {
  instagramUrl: string | null;
  tiktokUrl: string | null;
  whatsappNumber: string | null;
  message: string | null;
  updatedAt: Date | null;
  updatedByName: string | null;
};

/**
 * Seeded on first read (see getVerificationContact below) with the real
 * contact details the restaurant owner gave — see the /verify-account page
 * and restaurants.verifiedAt's own schema comment for the feature this
 * backs. Every field is editable afterward from /admin/system without a
 * code change; this is only ever used to create the very first row.
 */
const SEED_DEFAULTS = {
  instagramUrl: "https://www.instagram.com/restrokendra?igsi=MTB1NjhxdHlya3M2Yg%3D%3D&utm_source=qr",
  tiktokUrl: "https://www.tiktok.com/@restrokendra?_r=1&_t=ZS-99QEJngl60r",
  whatsappNumber: "9815300234",
  message:
    "Thanks for signing up for RestroKendra! Since online payments aren't set up yet, message us on WhatsApp, Instagram, or TikTok to get your account verified — we'll turn on full access as soon as we hear from you.",
} as const;

/**
 * Reads the singleton verification-contact row, seeding it with
 * SEED_DEFAULTS on first read if it doesn't exist yet — same "no seed
 * migration, first call creates the row" pattern as
 * getMaintenanceMode() in maintenance-mode-db.ts, except seeded with real
 * values instead of a blank/disabled state, so /verify-account works
 * correctly from the moment this ships, before any admin has visited the
 * settings panel.
 */
export async function getVerificationContact(): Promise<VerificationContact> {
  const [row] = await db
    .select({
      instagramUrl: platformVerificationContact.instagramUrl,
      tiktokUrl: platformVerificationContact.tiktokUrl,
      whatsappNumber: platformVerificationContact.whatsappNumber,
      message: platformVerificationContact.message,
      updatedAt: platformVerificationContact.updatedAt,
      updatedByName: users.fullName,
    })
    .from(platformVerificationContact)
    .leftJoin(users, eq(platformVerificationContact.updatedByUserId, users.id))
    .where(eq(platformVerificationContact.id, true))
    .limit(1);

  if (row) return row;

  await db
    .insert(platformVerificationContact)
    .values({ id: true, ...SEED_DEFAULTS })
    .onConflictDoNothing();

  return { ...SEED_DEFAULTS, updatedAt: null, updatedByName: null };
}

export async function setVerificationContact(params: {
  instagramUrl: string | null;
  tiktokUrl: string | null;
  whatsappNumber: string | null;
  message: string | null;
  userId: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(platformVerificationContact)
    .values({
      id: true,
      instagramUrl: params.instagramUrl,
      tiktokUrl: params.tiktokUrl,
      whatsappNumber: params.whatsappNumber,
      message: params.message,
      updatedByUserId: params.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformVerificationContact.id,
      set: {
        instagramUrl: params.instagramUrl,
        tiktokUrl: params.tiktokUrl,
        whatsappNumber: params.whatsappNumber,
        message: params.message,
        updatedByUserId: params.userId,
        updatedAt: now,
      },
    });
}
