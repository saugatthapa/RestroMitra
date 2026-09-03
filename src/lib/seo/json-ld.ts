import "server-only";
import { absoluteUrl } from "./site";
import { SITE_NAME } from "./metadata";

/**
 * JSON-LD builders. Every field here is either a structural fact (URL,
 * name, page hierarchy) or copied verbatim from real, already-published
 * copy (the homepage's own FAQ). None of these ever emit `aggregateRating`,
 * `review`, `sameAs` (social profiles), or `offers` with invented numbers —
 * those don't exist yet and the brief is explicit that fabricating them is
 * not an option (Phase 18/31). Add them here, factually, once they're real.
 */

export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: absoluteUrl("/"),
    logo: absoluteUrl("/brand/icon-512.png"),
  };
}

export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: absoluteUrl("/"),
  };
}

export function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web (installable as a PWA on Android and iOS)",
    description:
      "Restaurant POS and management software for Nepal: POS, QR ordering, kitchen display (KDS), inventory, staff, payroll, reservations, reports, and an AI assistant in one platform.",
    url: absoluteUrl("/"),
  };
}

export function createBreadcrumbSchema(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function createFaqSchema(items: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

/** Generic escape hatch for a one-off JSON-LD block a specific page needs (e.g. a future Article/Product schema) — keeps every page going through the same rendering helper (see JsonLd.tsx) rather than hand-rolling a <script> tag. */
export function createJsonLd<T extends Record<string, unknown>>(data: T): T {
  return data;
}
