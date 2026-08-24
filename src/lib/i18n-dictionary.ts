/**
 * Pure translation data + helpers — deliberately split out of i18n.tsx (which
 * holds the React provider/hooks and therefore contains JSX). Vitest/esbuild
 * can't reliably transform JSX in a .tsx file that's imported from a plain
 * .test.ts file when tsconfig sets "jsx": "preserve" (the project's Next.js
 * default), so anything that needs to be unit-tested directly — the
 * dictionary, translate(), trialDaysLeftText(), cartItemCountText() — lives
 * here instead, in a file with no JSX at all. i18n.tsx re-exports all of
 * this, so nothing importing from "@/lib/i18n" needs to change.
 */

export type Locale = "en" | "ne";

export const LOCALE_LABELS: Record<Locale, string> = { en: "English", ne: "नेपाली" };

// prettier-ignore
const DICTIONARY = {
  // --- Dashboard shell: nav groups ---
  "nav.overview": { en: "Overview", ne: "सिंहावलोकन" },
  "nav.frontOfHouse": { en: "Front of house", ne: "फ्रन्ट अफ हाउस" },
  "nav.backOffice": { en: "Back office", ne: "ब्याक अफिस" },
  "nav.account": { en: "Account", ne: "खाता" },
  // --- Dashboard shell: nav items ---
  "nav.dashboard": { en: "Dashboard", ne: "ड्यासबोर्ड" },
  "nav.reports": { en: "Reports", ne: "प्रतिवेदनहरू" },
  "nav.aiAssistant": { en: "AI Assistant", ne: "एआई सहायक" },
  "nav.orders": { en: "Orders", ne: "अर्डरहरू" },
  "nav.pos": { en: "POS", ne: "पिओएस" },
  "nav.kitchenKds": { en: "Kitchen (KDS)", ne: "भान्सा (केडीएस)" },
  "nav.tablesQr": { en: "Tables & QR", ne: "टेबल र क्युआर" },
  "nav.reservations": { en: "Reservations", ne: "आरक्षणहरू" },
  "nav.menu": { en: "Menu", ne: "मेनु" },
  "nav.inventory": { en: "Inventory", ne: "सामान सूची" },
  "nav.staff": { en: "Staff", ne: "कर्मचारी" },
  "nav.customers": { en: "Customers", ne: "ग्राहकहरू" },
  "nav.expenses": { en: "Expenses", ne: "खर्चहरू" },
  "nav.accountBooks": { en: "Account Books", ne: "खाता बही" },
  "nav.website": { en: "Website", ne: "वेबसाइट" },
  "nav.auditLog": { en: "Activity Log", ne: "गतिविधि लग" },
  "nav.register": { en: "Cash Register", ne: "नगद रजिस्टर" },
  "nav.branches": { en: "Branches", ne: "शाखाहरू" },
  "nav.billing": { en: "Billing", ne: "बिलिङ" },
  "nav.settings": { en: "Settings", ne: "सेटिङहरू" },
  "nav.comingSoon": { en: "Coming soon", ne: "चाँडै आउँदैछ" },
  // --- Dashboard shell: header chrome ---
  "nav.openPos": { en: "Open POS", ne: "पिओएस खोल्नुहोस्" },
  "nav.logOut": { en: "Log out", ne: "लगआउट" },
  "nav.poweredBy": { en: "Powered by RestroMitra", ne: "RestroMitra द्वारा संचालित" },
  "nav.collapseSidebar": { en: "Collapse sidebar", ne: "साइडबार साँघुरो गर्नुहोस्" },
  "nav.expandSidebar": { en: "Expand sidebar", ne: "साइडबार फराकिलो गर्नुहोस्" },
  "nav.notifications": { en: "Notifications", ne: "सूचनाहरू" },
  "nav.language": { en: "Language", ne: "भाषा" },

  // --- Public QR ordering menu ---
  "publicMenu.callStaff": { en: "Call staff", ne: "कर्मचारी बोलाउनुहोस्" },
  "publicMenu.calling": { en: "Calling…", ne: "बोलाउँदै…" },
  "publicMenu.staffNotified": { en: "Staff notified", ne: "कर्मचारीलाई सूचित गरियो" },
  "publicMenu.staffOnTheWay": { en: "Staff on the way", ne: "कर्मचारी आउँदैछन्" },
  "publicMenu.menuUnavailable": {
    en: "The menu isn't available for ordering right now. Please ask staff for help.",
    ne: "अहिले अर्डर गर्न मेनु उपलब्ध छैन। कृपया कर्मचारीलाई सोध्नुहोस्।",
  },
  "publicMenu.orderPlaced": { en: "Order placed!", ne: "अर्डर राखियो!" },
  "publicMenu.showScreenToStaff": {
    en: "Show this screen to staff if needed.",
    ne: "आवश्यक परे यो स्क्रिन कर्मचारीलाई देखाउनुहोस्।",
  },
  "publicMenu.orderNumberLabel": { en: "Order #", ne: "अर्डर #" },
  "publicMenu.tableLabel": { en: "Table", ne: "टेबल" },
  "publicMenu.totalLabel": { en: "Total", ne: "जम्मा" },
  "publicMenu.orderMore": { en: "Order more", ne: "थप अर्डर गर्नुहोस्" },
  "publicMenu.add": { en: "Add", ne: "थप्नुहोस्" },
  "publicMenu.poweredBy": { en: "Powered by RestroMitra", ne: "RestroMitra द्वारा संचालित" },
  "publicMenu.viewCart": { en: "View cart", ne: "कार्ट हेर्नुहोस्" },
  "publicMenu.chooseOption": { en: "Choose an option", ne: "एउटा विकल्प छान्नुहोस्" },
  "publicMenu.addons": { en: "Add-ons", ne: "थप चीजहरू" },
  "publicMenu.free": { en: "free", ne: "निःशुल्क" },
  "publicMenu.specialInstructions": {
    en: "Special instructions (optional)",
    ne: "विशेष निर्देशनहरू (वैकल्पिक)",
  },
  "publicMenu.quantity": { en: "Quantity", ne: "परिमाण" },
  "publicMenu.addToCart": { en: "Add to cart", ne: "कार्टमा थप्नुहोस्" },
  "publicMenu.backToMenu": { en: "← Back to menu", ne: "← मेनुमा फर्कनुहोस्" },
  "publicMenu.yourOrder": { en: "Your order", ne: "तपाईंको अर्डर" },
  "publicMenu.cartEmpty": { en: "Your cart is empty.", ne: "तपाईंको कार्ट खाली छ।" },
  "publicMenu.remove": { en: "Remove", ne: "हटाउनुहोस्" },
  "publicMenu.subtotal": { en: "Subtotal", ne: "उप-जम्मा" },
  "publicMenu.taxAtCheckout": { en: "Tax calculated at checkout", ne: "चेकआउटमा कर गणना गरिन्छ" },
  "publicMenu.checkout": { en: "Checkout", ne: "चेकआउट" },
  "publicMenu.backToCart": { en: "← Back to cart", ne: "← कार्टमा फर्कनुहोस्" },
  "publicMenu.yourNameOptional": { en: "Your name (optional)", ne: "तपाईंको नाम (वैकल्पिक)" },
  "publicMenu.phoneOptional": { en: "Phone number (optional)", ne: "फोन नम्बर (वैकल्पिक)" },
  "publicMenu.notesForKitchen": {
    en: "Notes for the kitchen (optional)",
    ne: "भान्साका लागि टिप्पणी (वैकल्पिक)",
  },
  "publicMenu.estimatedSubtotal": { en: "Estimated subtotal", ne: "अनुमानित उप-जम्मा" },
  "publicMenu.taxAddedOnSubmission": { en: "Tax added on submission", ne: "पेश गर्दा कर थपिन्छ" },
  "publicMenu.placingOrder": { en: "Placing order…", ne: "अर्डर राख्दै…" },
  "publicMenu.placeOrder": { en: "Place order", ne: "अर्डर राख्नुहोस्" },
  "publicMenu.couldNotPlaceOrder": {
    en: "Could not place your order. Please try again.",
    ne: "अर्डर राख्न सकिएन। कृपया फेरि प्रयास गर्नुहोस्।",
  },
  "publicMenu.couldNotReachStaff": {
    en: "Couldn't reach staff. Please try again.",
    ne: "कर्मचारीसम्म पुग्न सकिएन। कृपया फेरि प्रयास गर्नुहोस्।",
  },
} as const;

export type TranslationKey = keyof typeof DICTIONARY;

export function translate(key: TranslationKey, locale: Locale): string {
  return DICTIONARY[key][locale];
}

/** "3 days left in trial" / "ट्रायलमा ३ दिन बाँकी" — kept as a function (not a
 * dictionary entry) since it interpolates a count; Nepali digits are used
 * in the Nepali form to match how a Nepali-reading owner actually expects
 * to see a day count, not just translated surrounding words. */
export function trialDaysLeftText(days: number, locale: Locale): string {
  if (locale === "ne") {
    return `ट्रायलमा ${toNepaliDigits(days)} दिन बाँकी`;
  }
  return `${days} day${days === 1 ? "" : "s"} left in trial`;
}

/** "2 items" / "२ वस्तु" — same reasoning as trialDaysLeftText. */
export function cartItemCountText(count: number, locale: Locale): string {
  if (locale === "ne") {
    return `${toNepaliDigits(count)} वस्तु`;
  }
  return `${count} item${count === 1 ? "" : "s"}`;
}

const NEPALI_DIGITS = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"];

function toNepaliDigits(n: number): string {
  return String(n)
    .split("")
    .map((ch) => (ch >= "0" && ch <= "9" ? NEPALI_DIGITS[Number(ch)] : ch))
    .join("");
}
