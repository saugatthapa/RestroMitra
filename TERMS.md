# RestroMitra Terms of Service

**Last updated:** August 31, 2026

## Read this first

This document is **not legal advice**. It is a straightforward, honest draft of terms of service that describes what RestroMitra actually does and does not do today, written by reading the product's real behavior rather than a generic template. **Have this reviewed by a qualified lawyer before commercial launch** — especially the liability, billing, and termination sections, which carry real legal weight and vary by jurisdiction.

By creating an account or using RestroMitra ("the Service"), a restaurant and its authorized users agree to these terms.

## 1. What RestroMitra is

RestroMitra is a restaurant management platform providing point-of-sale, QR ordering, kitchen display, inventory, staff/attendance/payroll, customer loyalty, expense tracking, an internal ledger ("Account Books" — explicitly not a certified accounting or tax-compliance product), reservations, reporting, an AI assistant, and a restaurant website builder, run as a hosted, multi-tenant SaaS product.

## 2. Accounts

- An account is created with a full name, phone number (the unique login identifier), and password. Email is optional.
- The person or business that creates a restaurant's account is its **owner** and is responsible for inviting and managing staff accounts, assigning roles, and for everything done under that restaurant's account.
- You are responsible for keeping your login credentials confidential and for all activity under your account. Enabling two-factor authentication (available today as opt-in, not currently mandatory for any role) is recommended.
- Staff accounts are added by an owner/manager and are subject to role-based permissions the owner/manager controls — a restaurant is responsible for who it grants access to and what role it grants them.

## 3. Free trial, subscription, and billing

This section describes the billing behavior actually implemented in the product today, not an aspirational billing system.

- New restaurants start on a **30-day free trial**, no credit card required.
- After the trial, continued use requires an active paid subscription on one of the published plans (Starter/Growth/Pro, or any custom plan a platform administrator has configured for that restaurant specifically).
- **There is currently no automated payment gateway for subscription billing itself.** Requesting or changing a plan today is a manual, sales-assisted process (a restaurant requests a plan from its dashboard, and a RestroMitra platform administrator applies it) — not an automatic credit-card checkout. This will change as the product matures; this document should be updated if/when automated subscription billing is added.
- **Pricing already quoted to an existing restaurant is protected against future catalog price changes** ("price lock") — if RestroMitra changes the published price of a plan, a restaurant already on that plan keeps its existing price until it is explicitly changed for that restaurant, not silently repriced.
- **What actually happens if a subscription lapses or is cancelled, as implemented today:**
  - `past_due` is a deliberate grace period — access is **not** cut off immediately if a payment is late.
  - `trialing` past its end date, or a status of `paused`, `cancelled`, or `expired`, blocks access to the working application (POS, dashboard, etc.).
  - **Blocking access does not delete data.** No subscription state in this system triggers automatic deletion of a restaurant's data. A restaurant can regain full access by renewing/reactivating.
  - There is currently no self-service "cancel my subscription" button in the product — ending a subscription is handled the same way changing a plan is, by contacting RestroMitra rather than an automated flow. Marketing copy that says "cancel anytime" refers to there being no lock-in contract, not to a one-click self-service cancellation feature that does not yet exist — this document should not overstate that, and this feature gap should be closed (or the marketing copy adjusted) before making stronger self-service claims commercially.
- **We do not currently promise a specific refund policy**, because no automated billing/refund mechanism exists in the product for RestroMitra's own subscription fees. Any refund of a subscription charge today would be a manual, individually-arranged accommodation, not a standing contractual right this document should invent. This section should be rewritten once a real billing/refund mechanism exists.

## 4. Acceptable use

You agree not to:

- Use the Service for any unlawful purpose, or in a way that violates the rights of others (including your own customers' or staff's privacy rights);
- Attempt to access another restaurant's data, bypass tenant isolation, or probe/attack the Service's security;
- Reverse-engineer, resell, sublicense, or white-label the Service without a separate written agreement;
- Upload content (menu images, website content, customer data) you do not have the right to use;
- Use the attendance photo feature in a way that violates applicable law or your own staff's consent rights — RestroMitra provides a consent mechanism, but the restaurant using it is responsible for lawfully operating it (see `PRIVACY.md`).

RestroMitra may suspend or terminate an account for a clear violation of these terms, with notice where reasonably possible.

## 5. Data ownership

- **A restaurant owns its own business data** — its menu, orders, customers, staff records, inventory, financial records, and any content it uploads (logos, menu photos, website content). RestroMitra does not claim ownership of it and does not sell or share it with other restaurants or unrelated third parties.
- RestroMitra needs a license to store, process, and display that data back to you as part of operating the Service (e.g., rendering your dashboard, generating your reports, running your QR ordering page) — nothing more.
- See `PRIVACY.md` for what personal data (as distinct from general business data) is collected and how it is handled, and `DATA_RETENTION.md` for how long data is kept and what happens to it if an account is closed.
- Some data export exists today as a self-service feature (customers, inventory, ledger, suppliers, staff roster); other categories (orders, purchases, attendance, payroll) do not yet have a dedicated export tool. A restaurant wanting a full export of everything today should contact RestroMitra directly, as described in `PRIVACY.md`.

## 6. Third-party services

RestroMitra integrates with third-party services to provide certain features — for example, an AI provider for the assistant feature, an S3-compatible object storage provider for attendance photos, and (where configured) payment gateways for customer-facing order payments. Use of those features means the relevant data is processed by that third party as needed to provide the feature, subject to that provider's own terms.

## 7. Availability and support

- RestroMitra is provided on an "as available" basis. While the platform is built with tenant isolation, role-based access control, and audited actions, **no uptime guarantee (SLA) is made in this document**, and none should be implied — add one here only once the operational maturity (monitoring, on-call, backup automation) genuinely supports committing to it.
- Backups exist as a tested, documented process, but are performed manually today, not on an automated schedule — this is disclosed here rather than implying a guarantee the current operations don't yet back up.
- The only support channel today is direct contact with RestroMitra (see `PRIVACY.md` for the contact address) — there is not yet a self-service ticketing system inside the product for a restaurant to raise issues on its own.

## 8. Disclaimer of warranties

The Service is provided "as is" and "as available," without warranties of any kind, express or implied, including (without limitation) merchantability, fitness for a particular purpose, and non-infringement. RestroMitra does not warrant that the Service will be uninterrupted, error-free, or fully compliant with every tax, labor, or data-protection law applicable to your specific restaurant and jurisdiction — you remain responsible for confirming your own legal and tax compliance obligations (see the README's own note on this for Nepal IRD/PAN-VAT specifically: this has not been independently confirmed by a qualified professional).

## 9. Limitation of liability

To the maximum extent permitted by applicable law, RestroMitra and its operator(s) will not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of revenue, profits, or data, arising from your use of (or inability to use) the Service. Nothing in this section is intended to exclude liability that cannot lawfully be excluded in your jurisdiction — a lawyer should confirm the specific wording needed for the jurisdictions where RestroMitra actually operates.

## 10. Termination

- A restaurant may stop using the Service at any time (see §3 on the current, non-self-service way to formally end a subscription).
- RestroMitra may suspend or terminate access for a clear breach of these terms, non-payment beyond a reasonable grace period, or as required by law.
- Termination does not automatically delete a restaurant's data (see §5 and `DATA_RETENTION.md`) — data handling on termination follows the same non-destructive default described there, in the absence of a specific deletion request.

## 11. Changes to these terms

These terms may be updated as the product's actual features and billing mechanics change. Because this document is meant to describe the real product, not an aspiration, a material change to billing, data handling, or account behavior should come with an update here.

## 12. Governing law

This section is intentionally left for a lawyer to complete with the correct governing law and jurisdiction for wherever RestroMitra is legally operated from and where its restaurant customers are located — a generic or guessed jurisdiction clause here would very likely be wrong, so none is asserted.

## Contact

**legal@restromitra.com** (placeholder — set a real, monitored address before commercial launch).

---

*This draft was written by reading the actual application source code (billing, subscription-status, plan-catalog logic) as of this date, specifically so it does not promise a refund policy, an SLA, or a self-service cancellation flow the product does not actually have. Before commercial launch, have this reviewed and completed by a lawyer qualified to advise on SaaS terms in every jurisdiction where RestroMitra will actually operate.*
