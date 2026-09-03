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

export const RESTRONP = {
  name: "Restronp",
  homepageUrl: "https://www.restronp.com/",
  sources: ["https://www.restronp.com/", "https://www.restronp.com/pricing"],
  selfClaims: [
    `Titles itself "Best Restaurant Management & POS Billing Software in Nepal"`,
    `Describes itself as "Nepal's Restaurant POS & Billing App"`,
    `"We provide service all over Nepal"`,
    "Displays customer testimonials (dated 2025) but no numeric rating or customer-count figure",
  ],
  pricing: {
    // Annual-only, like RestroX — monthly-equivalent computed here for a
    // like-for-like comparison, never presented as a plan Restronp itself
    // sells.
    plans: [
      { name: "Basic", priceRsYearly: 6000, monthlyEquivalentRs: 500, limits: "Up to 5 user logins, up to 16 tables/rooms, up to 500 dishes" },
      { name: "Premium", priceRsYearly: 12000, monthlyEquivalentRs: 1000, limits: "Up to 24 user logins, up to 50 tables, up to 1,000 dishes, 24/7 call & chat support" },
      { name: "Platinum", priceRsYearly: 24000, monthlyEquivalentRs: 2000, limits: "Unlimited users, tables, and dishes; dedicated 24/7 call & chat support" },
    ],
    // Their homepage references a free trial without stating a length; the
    // pricing page itself lists no free-trial terms — stated as-is rather
    // than guessing a number of days.
    freeTrialNote: "A free trial is referenced on their site, but no specific length is published.",
  },
  features: [
    "POS & billing",
    "Kitchen Order Ticket (KOT) system — instant kitchen alerts, order priority, auto-print",
    "Table booking / reservation tracking",
    "Menu management",
    "Inventory tracking",
    "QR code contactless menu ordering",
    "Reports & analytics (invoices, sales, payments, customers, products, tax — exportable)",
    "Staff role management and permissions",
    "Multi-branch support (single outlet to multi-outlet chains)",
    "Dine-in, takeaway, and delivery order modes",
  ],
  // Explicitly not found on their site as of the last-reviewed date:
  notMentioned: ["Payroll", "Loyalty program", "Website builder", "AI features", "QR ordering-linked inventory deduction"],
} as const;

export const RECAHO = {
  name: "Recaho",
  homepageUrl: "https://www.recaho.com/",
  // Recaho is a multi-country POS company (not Nepal-only); this is their
  // Nepal-targeted landing page, which is what actually ranks for Nepal
  // searches and is the fair comparison surface.
  sources: ["https://www.recaho.com/", "https://www.recaho.com/s/restaurant-management-software-in-nepal"],
  selfClaims: [
    `"Trusted by 15,000+ Businesses across 18+ Countries"`,
    `Operates in "300+ Cities"`,
    `"99.998% Uptime"`,
    "Displays rating badges from multiple review platforms (Google, G2, Capterra, GetApp, Software Advice) without a single headline number quoted on their own site",
  ],
  pricing: {
    // No pricing page could be found on their own site (a direct
    // /pricing URL returned a 404), and no third-party listing surfaced a
    // number either — stated as a fact rather than guessed.
    publiclyDisclosed: false,
    note: "Pricing is not published on Recaho's site — it's request-a-quote only, as of the last-reviewed date.",
  },
  features: [
    "POS billing",
    "Kitchen Display System (KDS)",
    "Captain/waiter ordering app",
    "Table reservation and queue management",
    "Inventory & recipe management, recipe costing",
    "Purchase and vendor management",
    "Production management",
    "Label printing (shelf-life, barcodes)",
    "Online ordering website",
    "QR menu website",
    "CRM with loyalty and wallet features",
    "WhatsApp and email marketing",
    "\"Recaho Mind\" — an AI tool for marketing, operations, and menu optimization",
    "Self-ordering kiosks",
    "Call center system",
    "Multi-outlet management",
    "Accounting integration",
  ],
} as const;

export const HAMROSAN = {
  name: "Hamro SAN",
  homepageUrl: "https://hamrosan.com/",
  sources: ["https://hamrosan.com/"],
  selfClaims: [
    `"5,000+ businesses"`,
    `"50+ districts"`,
    `"24/7 support" with "99% uptime"`,
    "Claims most users learn the system in 1 day",
  ],
  pricing: {
    plans: [
      { name: "Silver", priceRsMonthly: 599, limits: "1 user, 10 tables, 500 items, 10,000 invoices/year" },
      { name: "Gold", priceRsMonthly: 999, limits: "6 users, 20 tables, 2,500 items, 50,000 invoices/year" },
      { name: "Platinum", priceRsMonthly: 1199, limits: "Unlimited users, tables, items, and invoices" },
    ],
    freeTrialDays: 7,
    // Quoted as-is — an unusual one-time offer worth surfacing accurately
    // rather than omitting.
    specialOffer: `Advertises a one-time "unlimited subscription membership package" for Rs 1,00,000 (NPR 100,000).`,
  },
  features: [
    "Point of sale (POS)",
    "Inventory management with barcode scanning",
    "Kitchen Order Tickets (KOT)",
    "Table management and billing",
    "Accounting / finance module",
    "Sales analytics and reporting",
    "Digital menu with QR codes",
    "Recipe management",
    "Production management",
    "Accounts receivable and accounts payable",
    "Expiry tracking and low-stock alerts",
    "Credit / customer account tracking",
  ],
  notMentioned: ["Staff/payroll management", "Loyalty program", "Reservations", "Website builder", "AI features"],
} as const;

/**
 * Meromenu (meromenu.com) also appeared in the user's own "nepal restaurant
 * software" search and was investigated, but deliberately has NO entry
 * here and no /compare or /alternatives page: their site is a fully
 * client-rendered app shell that returns no readable content to
 * WebFetch, no pricing is published anywhere (their own site or any
 * third-party listing checked), and the one third-party feature listing
 * found (SoftwareSuggest) explicitly flags itself as incomplete. Building
 * a comparison page from that would mean guessing at a competitor's
 * features/pricing, which the brief explicitly forbids. Revisit if their
 * site becomes fetchable or a primary-source pricing page turns up — see
 * SEO_CONTENT_CALENDAR.md.
 */
