"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { translate, type Locale, type TranslationKey } from "./i18n-dictionary";

/**
 * Site-wide language preference — Phase 24. Same architecture as
 * date-system.tsx's AD/BS toggle (a per-device localStorage preference read
 * through a React context wrapping the relevant tree), deliberately not a
 * heavier i18n framework: the translated surface today is the dashboard
 * shell (nav/header chrome, visible on every screen) and the public QR
 * ordering menu — a flat key -> {en, ne} dictionary is the right amount of
 * machinery for that, not a routing-level locale system with per-page JSON
 * bundles. Extending coverage later just means adding more keys to
 * i18n-dictionary.ts; the plumbing here doesn't change.
 *
 * The dictionary, translate(), and the count-interpolating helpers live in
 * i18n-dictionary.ts (a plain .ts file, no JSX) rather than here, so they can
 * be unit-tested directly without pulling React/JSX through vitest's
 * transform — see that file's header comment for why.
 *
 * Two SEPARATE preferences, two separate contexts/keys, deliberately not
 * shared: LocaleProvider (dashboard, staff/owner accounts, persisted per
 * logged-in device) and the public order page's own toggle (a guest's
 * phone, no login, its own localStorage key — see PublicOrderMenu.tsx).
 * A waiter's dashboard language choice has nothing to do with which
 * language the guest sitting at table 5 wants to read the menu in.
 */

export { LOCALE_LABELS, translate, trialDaysLeftText, cartItemCountText } from "./i18n-dictionary";
export type { Locale, TranslationKey } from "./i18n-dictionary";

const LOCALE_KEY = "restromitra:locale";

type LocaleContextValue = { locale: Locale; setLocale: (next: Locale) => void };

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readInitialLocale(key: string): Locale {
  if (typeof window === "undefined") return "en";
  return window.localStorage.getItem(key) === "ne" ? "ne" : "en";
}

/** Wraps the dashboard (DashboardShell) — a logged-in staff/owner device's language preference. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => readInitialLocale(LOCALE_KEY));

  useEffect(() => {
    window.localStorage.setItem(LOCALE_KEY, locale);
  }, [locale]);

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

/** Read + write access to the dashboard's language preference — the header toggle. */
export function useLocaleControl(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocaleControl must be used within a LocaleProvider");
  return ctx;
}

/** `t(key)` bound to the dashboard's current locale — the common case for translating a string in a component under LocaleProvider. */
export function useTranslation(): { t: (key: TranslationKey) => string; locale: Locale } {
  const ctx = useContext(LocaleContext);
  const locale = ctx?.locale ?? "en";
  return { t: (key) => translate(key, locale), locale };
}

const GUEST_LOCALE_KEY = "restromitra:guest-locale";

/** A standalone locale+t() pair for the public order page — deliberately NOT
 * sharing LocaleProvider/LOCALE_KEY with the dashboard (see the module doc
 * comment above for why). Used directly as a hook, no provider needed,
 * since only one component tree (the public order page) ever needs it. */
export function useGuestTranslation(): {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TranslationKey) => string;
} {
  const [locale, setLocaleState] = useState<Locale>(() => readInitialLocale(GUEST_LOCALE_KEY));

  function setLocale(next: Locale) {
    setLocaleState(next);
    if (typeof window !== "undefined") window.localStorage.setItem(GUEST_LOCALE_KEY, next);
  }

  return { locale, setLocale, t: (key) => translate(key, locale) };
}
