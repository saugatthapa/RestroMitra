import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { getVerificationContact } from "@/lib/system/verification-contact-db";
import { whatsappLink } from "@/lib/whatsapp";
import { LogoutButton } from "@/app/billing/LogoutButton";
import { NOINDEX } from "@/lib/seo/metadata";

// System-state interstitial, not real content — never indexable.
export const metadata: Metadata = { robots: NOINDEX };

/**
 * No payment gateway is integrated yet, so a self-serve signup can't be
 * confirmed as a real, paying restaurant the way a checkout would confirm
 * it — see restaurants.verifiedAt's own schema comment. The dashboard
 * layout redirects an unverified restaurant's staff here (same "deliberately
 * top-level route, not under /dashboard, so it's reachable regardless of
 * the same blocked state" reasoning as /suspended — see that page's own
 * comment) until a platform admin manually confirms them via WhatsApp,
 * Instagram, or TikTok and flips them to verified from the admin restaurant
 * detail page's Verification panel.
 *
 * Contact details and the message shown below are admin-editable from
 * /admin/system (see verification-contact-db.ts) — nothing here is
 * hardcoded, so they can be changed without a code deploy.
 */
export default async function VerifyAccountPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/verify-account");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  const contact = await getVerificationContact();
  const waLink = contact.whatsappNumber ? whatsappLink(contact.whatsappNumber) : null;

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              Restro<span className="text-orange-600">Kendra</span>
            </span>
            <span className="text-[10px] font-medium text-neutral-400">by Saugat Thapa</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-500">{active.name}</span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-lg p-4 py-16 text-center md:p-8">
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-6">
          <h1 className="text-lg font-semibold text-orange-900">One quick step left</h1>
          <p className="mt-2 text-sm text-orange-800">
            {contact.message ??
              "Thanks for signing up! Message us to get your account verified — we'll turn on full access as soon as we hear from you."}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {waLink && (
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 shadow-sm transition hover:border-green-300 hover:bg-green-50"
            >
              WhatsApp us
            </a>
          )}
          {contact.instagramUrl && (
            <a
              href={contact.instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 shadow-sm transition hover:border-pink-300 hover:bg-pink-50"
            >
              Instagram
            </a>
          )}
          {contact.tiktokUrl && (
            <a
              href={contact.tiktokUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 shadow-sm transition hover:border-neutral-400 hover:bg-neutral-100"
            >
              TikTok
            </a>
          )}
        </div>

        <p className="mt-6 text-xs text-neutral-400">
          Your account and everything you set up during onboarding is saved — nothing is lost
          while you wait. This usually only takes a short message.
        </p>
      </main>
    </div>
  );
}
