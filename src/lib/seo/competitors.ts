/**
 * Sourced competitor facts for the /compare and /alternatives pages built
 * in the SEO pass — SEO_AUDIT.md / the master SEO brief are explicit that
 * none of this may be fabricated. Every figure here was pulled directly
 * from the competitor's own public site (see `sources` on each entry) via
 * WebFetch during this pass. Centralized in one file so a re-check only
 * has to update figures in one place, and so the two /compare pages and
 * two /alternatives pages never quote the same competitor two different
 * ways.
 *
 * "Last reviewed" is a real, honest date (this file's authoring date), not
 * decorative copy — refresh it (and the figures) whenever this file is
 * next revisited.
 */

export const LAST_REVIEWED = "September 3, 2026";

export const RESTROKENDRA_PLANS = [
  { name: "Starter", priceRsMonthly: 799, staff: "Up to 5 staff", branches: "1 branch" },
  { name: "Growth", priceRsMonthly: 1399, staff: "Up to 15 staff", branches: "Up to 3 branches" },
  { name: "Pro", priceRsMonthly: 3499, staff: "Unlimited staff", branches: "Unlimited branches" },
] as const;

export const RESTROHUB = {
  name: "RestroHub",
  homepageUrl: "https://restrohub.com.np/",
  sources: ["https://restrohub.com.np/", "https://restrohub.com.np/llms-full.txt"],
  // RestroHub's own homepage claims, quoted so a reader can see exactly
  // what the vendor says about itself — not something RestroKendra is
  // asserting as fact.
  selfClaims: [
    `"#1 best restaurant management software in Nepal"`,
    `"500+ restaurants"`,
    `"4.9/5 from 30+ verified reviews"`,
    `Describes itself as "the cheapest" option in the Nepali market`,
    "24/7 bilingual (Nepali/English) customer support",
  ],
  pricing: {
    monthlyRs: 1400,
    annualRs: 15400,
    annualNote: "billed yearly, marketed as \"12 months + 1 free\"",
    oneAndHalfYearRs: 23800,
    oneAndHalfYearNote: "18-month term, marketed as \"18 months + 1 free + free NFC table cards\"",
    hasFreeTier: true,
    enterpriseCustomQuote: true,
  },
  features: [
    "POS with split billing",
    "QR table ordering",
    "Kitchen display / bar display (KDS/BDS)",
    "RestroBuddy — an AI chatbot with about 13 action tools",
    "Tiered loyalty program",
    "Inventory with recipe-based deduction",
    "Staff & attendance tracking (selfie + PIN verification)",
    "Free website builder — 12 block types, 3 themes, SEO-ready, custom domain support",
    "Real-time analytics",
    "Floor plan designer",
    "Reservations",
    "Combo/bundle builder",
    "Multi-branch support",
    "Customer ledger",
  ],
} as const;

export const RESTROX = {
  name: "RestroX",
  homepageUrl: "https://www.restrox.com/np",
  sources: ["https://www.restrox.com/np", "https://www.restrox.com/np/pricing"],
  selfClaims: [
    `Describes itself as "Nepal's Trusted Restaurant POS"`,
    `"#1 Restaurant Software"`,
    "Cites roughly 9,000 orders processed on the platform",
    "4.5/5 average rating (per its own homepage)",
  ],
  pricing: {
    // RestroX prices annually only (no monthly billing option) — figures
    // below are the vendor's own annual price, plus a monthly-equivalent
    // computed here for a like-for-like comparison with RestroKendra's
    // monthly pricing. Always labeled as an equivalent, never presented as
    // an actual monthly plan RestroX itself offers.
    plans: [
      {
        name: "Free",
        priceRsYearly: 0,
        monthlyEquivalentRs: 0,
        limits: "100 dishes, 10 categories, 5 add-ons, 3 sub-menus, 1 menu set; daybook and basic income/expense tracking",
      },
      {
        name: "Basic",
        priceRsYearly: 12000,
        monthlyEquivalentRs: 1000,
        limits: "5 logins, 20 tables, 500 dishes, dine-in & delivery, KOT/BOT, 30 customer records",
      },
      {
        name: "Premium",
        priceRsYearly: 24000,
        monthlyEquivalentRs: 2000,
        limits: "Adds inventory management, accounting, CRM & loyalty; 24 logins, 50 tables, 1,000 dishes, 500 customer records, advanced insights. 50% renewal discount after year one.",
      },
      {
        name: "Platinum",
        priceRsYearly: 60000,
        monthlyEquivalentRs: 5000,
        limits: "Adds multi-outlet management, 24/7 priority support, unlimited users/tables/dishes, advanced reporting, eBilling; 1,000 customer records. 50% renewal discount after year one.",
      },
    ],
    enterpriseCustomQuote: true,
    freeTrialDays: 14,
  },
  features: [
    "POS with KOT/BOT",
    "Dine-in & delivery order types",
    "Daybook and income/expense tracking",
    "Inventory management (Premium tier and above)",
    "Accounting (Premium tier and above)",
    "CRM & loyalty (Premium tier and above)",
    "Multi-outlet management (Platinum tier and above)",
    "eBilling (Platinum tier and above)",
    "Custom branded mobile app, dedicated server/DB, franchise management, custom API, dedicated account manager (Enterprise, custom quote)",
  ],
} as const;
