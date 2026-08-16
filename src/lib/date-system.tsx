"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type DateSystem = "AD" | "BS";

const DATE_SYSTEM_KEY = "dhankipos:date-system";

type DateSystemContextValue = {
  dateSystem: DateSystem;
  setDateSystem: (next: DateSystem) => void;
};

const DateSystemContext = createContext<DateSystemContextValue | null>(null);

/**
 * Site-wide AD/BS calendar preference. Wraps the dashboard once (in
 * DashboardShell) so every screen under it — Orders, Reports, Reservations,
 * Expenses, Account Books, Customers, Staff, Inventory, and the header
 * toggle itself — reads and writes the *same* preference instead of each
 * screen inventing its own. Persisted to localStorage under the same key
 * the toggle already used before this existed, so an existing user's choice
 * carries over rather than resetting to the BS default.
 */
export function DateSystemProvider({ children }: { children: ReactNode }) {
  const [dateSystem, setDateSystem] = useState<DateSystem>(() => {
    if (typeof window === "undefined") return "BS";
    return window.localStorage.getItem(DATE_SYSTEM_KEY) === "AD" ? "AD" : "BS";
  });

  useEffect(() => {
    window.localStorage.setItem(DATE_SYSTEM_KEY, dateSystem);
  }, [dateSystem]);

  return (
    <DateSystemContext.Provider value={{ dateSystem, setDateSystem }}>
      {children}
    </DateSystemContext.Provider>
  );
}

/**
 * Read-only access to the current AD/BS preference. Falls back to "BS"
 * (this app's default) if called outside the provider rather than throwing
 * — every dashboard screen is expected to render under DashboardShell, but
 * a stray usage shouldn't crash the page over a display preference.
 */
export function useDateSystem(): DateSystem {
  const ctx = useContext(DateSystemContext);
  return ctx?.dateSystem ?? "BS";
}

/** Read + write access — only the header toggle itself needs this. */
export function useDateSystemControl(): DateSystemContextValue {
  const ctx = useContext(DateSystemContext);
  if (!ctx) {
    throw new Error("useDateSystemControl must be used within a DateSystemProvider");
  }
  return ctx;
}
