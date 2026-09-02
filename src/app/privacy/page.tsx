import type { Metadata } from "next";
import { LegalPageShell, LegalDisclaimer, LegalSection } from "@/components/legal/LegalPageShell";

export const metadata: Metadata = {
  title: "Privacy Policy — RestroKendra",
  description: "What personal data RestroKendra collects, why, how it's stored, and how long it's kept.",
};

// Rendered content mirrors PRIVACY.md at the repo root — that file is the
// source of truth (kept in sync with the actual application code); this
// page exists so the same content is reachable at a public URL. Update
// both together.
export default function PrivacyPolicyPage() {
  return (
    <LegalPageShell title="Privacy Policy" lastUpdated="August 31, 2026">
      <LegalDisclaimer>
        This document is <strong>not legal advice</strong>, and it is not a substitute for a qualified
        lawyer&apos;s review before commercial launch. It is a plain, honest description of what
        RestroKendra actually collects, stores, and does with personal data today. If you run a
        restaurant on RestroKendra, you are responsible for your own lawful basis to collect your
        customers&apos; and staff&apos;s data — this page describes what the software does, not your own
        legal obligations to the people whose data you put into it.
      </LegalDisclaimer>

      <LegalSection heading="Who this covers">
        <p>
          This policy applies to personal data processed by the RestroKendra platform: the software
          used by restaurant owners, managers, and staff to run point-of-sale, ordering, staff, and
          accounting operations, and by their customers using a restaurant&apos;s QR ordering, loyalty,
          or reservation features.
        </p>
      </LegalSection>

      <LegalSection heading="1. Restaurant owners, managers, and staff accounts">
        <p>We collect a full name and phone number (your login identifier), an optional email address, and a password stored only as a one-way hash. We also store your role/permissions at each restaurant, and session metadata needed to keep you logged in. If you enable two-factor authentication, we store a TOTP secret and backup codes — the TOTP secret is kept in a readable form, because verifying a live login code requires reading it back; this is a deliberate, disclosed exception, not an oversight.</p>
      </LegalSection>

      <LegalSection heading="2. Staff employment and payroll data">
        <p>
          For paid staff, a restaurant&apos;s owner/manager can record salary configuration, bank
          account details (if they choose to), payroll payment history, attendance records, leave
          requests, and holidays. RestroKendra does not initiate bank transfers — this data exists for
          the restaurant&apos;s own record-keeping.
        </p>
      </LegalSection>

      <LegalSection heading="3. Staff attendance photos (“selfie verification”)">
        <ul className="list-disc space-y-2 pl-5">
          <li>A restaurant can optionally turn on photo-verified clock-in/clock-out. One photo is captured per clock-in and clock-out, from the staff member&apos;s own device camera.</li>
          <li>Consent is required before the first photo — a staff member is shown a plain-language notice explaining what&apos;s collected, why, who can see it, and how long it&apos;s kept, and must actively agree. Every consent version anyone has ever agreed to is kept permanently, never overwritten.</li>
          <li>Photos are stored in <strong>private object storage</strong> (an S3-compatible bucket), never in the application database, never publicly reachable.</li>
          <li>Photos are only ever viewed through a <strong>short-lived, signed URL</strong> minted at the moment someone with permission looks at it — no permanent public link exists.</li>
          <li>Who can see a photo: that restaurant&apos;s own owner/managers, and RestroKendra platform staff for support or legal purposes if genuinely needed.</li>
          <li>
            <strong>Retention: 90 days by default</strong> (configurable per deployment via
            <code className="mx-1 rounded bg-surface-1 px-1.5 py-0.5 text-[13px]">ATTENDANCE_PHOTO_RETENTION_DAYS</code>
            ), after which a purge routine deletes the file and clears the database record. <strong>That purge does not run on its own schedule</strong> — this product has no background job runner, so it only runs when a platform administrator (or an operator&apos;s external cron job) triggers it. In a deployment where nobody has wired that up, expired photos are not actually deleted on time — a real gap, stated here plainly.
          </li>
          <li>A staff member can decline consent and still clock in/out without a photo, unless their specific restaurant requires one.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. Customers">
        <p>
          Depending on which features a restaurant uses, a customer may have their phone number,
          name, optional email/date of birth, order history, loyalty points/tier, visit streaks, and
          any notes staff add stored against their profile. This is collected by the restaurant
          operating RestroKendra for its own CRM and loyalty purposes. Each restaurant&apos;s customer
          list is isolated from every other restaurant&apos;s on the platform — none of it is sold,
          rented, or shared across restaurants.
        </p>
      </LegalSection>

      <LegalSection heading="5. Financial records">
        <p>
          A restaurant&apos;s expenses, purchases, supplier records, ledger/&quot;Account Books&quot; entries,
          cash-register sessions, and end-of-day closes are stored as that restaurant&apos;s own
          business data, visible only to its own authorized staff by role/permission.
        </p>
      </LegalSection>

      <LegalSection heading="6. AI assistant usage">
        <p>
          If a restaurant uses the AI assistant, its questions and the data pulled to answer them are
          sent to a configured third-party AI provider, scoped strictly to that restaurant&apos;s own
          data. A restaurant-supplied AI provider API key is stored <strong>encrypted</strong> at
          rest, not in plain text.
        </p>
      </LegalSection>

      <LegalSection heading="How data is stored and protected">
        <ul className="list-disc space-y-2 pl-5">
          <li>Every restaurant&apos;s data is isolated from every other restaurant&apos;s at the application layer.</li>
          <li>Passwords are one-way hashed; attendance selfies live in private object storage behind signed URLs; AI provider keys are encrypted at rest.</li>
          <li>Sensitive actions (payroll changes, refunds, staff management, platform-admin actions) are recorded in an audit log.</li>
          <li>RestroKendra has not undergone an independent third-party security audit or penetration test as of this writing.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Retention and deletion">
        <p>
          See the <code className="rounded bg-surface-1 px-1.5 py-0.5 text-[13px]">DATA_RETENTION.md</code> document in the project repository for the full per-category breakdown. In short: attendance photos default to a 90-day retention window; everything else (accounts, orders, payroll, ledger, customer records) is kept for as long as a restaurant&apos;s account exists. <strong>There is currently no self-service &quot;delete my account and all data&quot; feature</strong> for owners, staff, or customers — removing data today requires a direct request handled manually by whoever operates the platform. Cancelling or letting a subscription lapse does <strong>not</strong> delete a restaurant&apos;s data.
        </p>
      </LegalSection>

      <LegalSection heading="How to request deletion or export">
        <p>
          If you are a restaurant&apos;s customer or staff member, ask that restaurant&apos;s owner/manager
          first — they control your data and can action most requests directly. If you are a
          restaurant owner, or your manager can&apos;t resolve the request, contact{" "}
          <a className="font-medium text-orange-400 underline underline-offset-2" href="mailto:privacy@restromitra.com">
            privacy@restromitra.com
          </a>{" "}
          (a placeholder address — to be replaced with a real, monitored inbox before commercial
          launch). Some export already works today as a self-service feature (customers, inventory,
          ledger, suppliers, staff roster); orders, purchases, attendance, and payroll do not yet
          have a dedicated export tool.
        </p>
      </LegalSection>

      <LegalSection heading="Children's data">
        <p>
          RestroKendra is a business tool, not intended for use by children, and does not knowingly
          collect data about children beyond what a restaurant might record about its own staff.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          This page is updated whenever the product&apos;s actual data practices change — it is meant
          to describe reality, not aspirations.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          <a className="font-medium text-orange-400 underline underline-offset-2" href="mailto:privacy@restromitra.com">
            privacy@restromitra.com
          </a>{" "}
          (placeholder — set a real, monitored address before commercial launch).
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
