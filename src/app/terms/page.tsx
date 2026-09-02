import type { Metadata } from "next";
import { LegalPageShell, LegalDisclaimer, LegalSection } from "@/components/legal/LegalPageShell";

export const metadata: Metadata = {
  title: "Terms of Service — RestroKendra",
  description: "The terms that apply when a restaurant creates an account and uses RestroKendra.",
};

// Rendered content mirrors TERMS.md at the repo root — that file is the
// source of truth (kept in sync with the actual application code); this
// page exists so the same content is reachable at a public URL. Update
// both together.
export default function TermsOfServicePage() {
  return (
    <LegalPageShell title="Terms of Service" lastUpdated="August 31, 2026">
      <LegalDisclaimer>
        This document is <strong>not legal advice</strong>. It is a straightforward, honest draft
        describing what RestroKendra actually does and does not do today, written by reading the
        product&apos;s real behavior rather than a generic template. Have this reviewed by a qualified
        lawyer before commercial launch — especially the billing, liability, and termination
        sections below. By creating an account or using RestroKendra (&quot;the Service&quot;), a restaurant
        and its authorized users agree to these terms.
      </LegalDisclaimer>

      <LegalSection heading="1. What RestroKendra is">
        <p>
          A restaurant management platform providing point-of-sale, QR ordering, kitchen display,
          inventory, staff/attendance/payroll, customer loyalty, expense tracking, an internal
          ledger (&quot;Account Books&quot; — explicitly not a certified accounting or tax-compliance
          product), reservations, reporting, an AI assistant, and a restaurant website builder, run
          as a hosted, multi-tenant SaaS product.
        </p>
      </LegalSection>

      <LegalSection heading="2. Accounts">
        <ul className="list-disc space-y-2 pl-5">
          <li>An account is created with a full name, phone number (your login identifier), and password. Email is optional.</li>
          <li>The person/business that creates a restaurant&apos;s account is its <strong>owner</strong> and is responsible for inviting and managing staff and for everything done under that account.</li>
          <li>You are responsible for keeping your login credentials confidential. Two-factor authentication is available today as opt-in, not currently mandatory for any role.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="3. Free trial, subscription, and billing">
        <p>This section describes billing behavior actually implemented today, not an aspirational billing system.</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>New restaurants start on a <strong>30-day free trial</strong>, no credit card required.</li>
          <li>
            <strong>There is currently no automated payment gateway for subscription billing itself.</strong>{" "}
            Requesting or changing a plan is a manual, sales-assisted process handled by a
            RestroKendra platform administrator — not an automatic credit-card checkout.
          </li>
          <li>Pricing already quoted to an existing restaurant is protected against future catalog price changes — a restaurant already on a plan keeps its existing price unless explicitly changed for it.</li>
          <li>
            A late payment (&quot;past due&quot;) does not immediately cut off access — this is a deliberate
            grace period. A lapsed trial, or a paused/cancelled/expired status, blocks working
            access but <strong>does not delete any data</strong>. Full access returns on renewal.
          </li>
          <li>
            <strong>There is currently no self-service &quot;cancel my subscription&quot; button.</strong>{" "}
            Ending a subscription is handled the same manual way as changing a plan. Marketing
            copy saying &quot;cancel anytime&quot; refers to there being no lock-in contract, not to a
            one-click self-service feature that doesn&apos;t exist yet.
          </li>
          <li>
            <strong>No specific refund policy is promised</strong>, because no automated
            billing/refund mechanism exists for subscription fees today. Any refund would be a
            manual, individually-arranged accommodation.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. Acceptable use">
        <p>You agree not to use the Service unlawfully or in a way that violates others&apos; rights (including your own customers&apos;/staff&apos;s privacy rights); attempt to access another restaurant&apos;s data or attack the Service&apos;s security; reverse-engineer, resell, or white-label the Service without a separate agreement; upload content you don&apos;t have the right to use; or use the attendance-photo feature in a way that violates applicable law or your staff&apos;s consent rights — RestroKendra provides a consent mechanism, but you are responsible for lawfully operating it.</p>
      </LegalSection>

      <LegalSection heading="5. Data ownership">
        <p>
          <strong>A restaurant owns its own business data</strong> — its menu, orders, customers,
          staff records, inventory, financial records, and uploaded content. RestroKendra does not
          claim ownership of it and needs only the license required to store, process, and display
          it back to you as part of operating the Service. See our Privacy Policy for how personal
          data specifically is handled.
        </p>
      </LegalSection>

      <LegalSection heading="6. Third-party services">
        <p>RestroKendra integrates with third-party services for certain features — an AI provider for the assistant, S3-compatible object storage for attendance photos, and (where configured) payment gateways for customer-facing order payments. Using those features means the relevant data is processed by that provider as needed, subject to its own terms.</p>
      </LegalSection>

      <LegalSection heading="7. Availability and support">
        <p>The Service is provided on an &quot;as available&quot; basis, with no uptime guarantee (SLA) made in this document. Backups exist as a tested, documented process, but run manually today, not on an automated schedule. The only support channel today is direct contact with RestroKendra — there is not yet a self-service ticketing system inside the product.</p>
      </LegalSection>

      <LegalSection heading="8. Disclaimer of warranties">
        <p>The Service is provided &quot;as is&quot; and &quot;as available,&quot; without warranties of any kind. RestroKendra does not warrant the Service is uninterrupted, error-free, or fully compliant with every tax, labor, or data-protection law applicable to your specific restaurant and jurisdiction — you remain responsible for confirming your own legal and tax compliance obligations.</p>
      </LegalSection>

      <LegalSection heading="9. Limitation of liability">
        <p>To the maximum extent permitted by law, RestroKendra and its operator(s) will not be liable for indirect, incidental, special, consequential, or punitive damages, or loss of revenue, profits, or data, arising from your use of the Service.</p>
      </LegalSection>

      <LegalSection heading="10. Termination">
        <p>A restaurant may stop using the Service at any time. RestroKendra may suspend or terminate access for a clear breach of these terms, non-payment beyond a reasonable grace period, or as required by law. Termination does not automatically delete a restaurant&apos;s data.</p>
      </LegalSection>

      <LegalSection heading="11. Changes to these terms">
        <p>These terms are updated as the product&apos;s actual features and billing mechanics change.</p>
      </LegalSection>

      <LegalSection heading="12. Governing law">
        <p>Intentionally left for a lawyer to complete with the correct governing law and jurisdiction — a guessed jurisdiction clause here would likely be wrong, so none is asserted.</p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          <a className="font-medium text-orange-600 underline underline-offset-2" href="mailto:legal@restromitra.com">
            legal@restromitra.com
          </a>{" "}
          (placeholder — set a real, monitored address before commercial launch).
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
