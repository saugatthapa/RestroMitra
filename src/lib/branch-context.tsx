"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type SelectableBranch = { id: string; name: string; isMain: boolean };

function storageKey(restaurantId: string) {
  return `dhankipos:active-branch:${restaurantId}`;
}

type BranchContextValue = {
  /** Every branch this user may switch to — see getSelectableBranches for
   *  who gets more than one. Header (DashboardShell) hides its switcher
   *  entirely when this has 1 or fewer entries, same convention as the
   *  restaurant switcher. */
  branches: SelectableBranch[];
  /** null = "All branches" (the restaurant-wide default, matching every
   *  report/screen's behavior before this feature existed). */
  activeBranchId: string | null;
  setActiveBranchId: (id: string | null) => void;
};

const BranchContext = createContext<BranchContextValue | null>(null);

/**
 * Phase 24 — lets the header's branch switcher scope Reports (and any
 * future screen) to one branch of a multi-branch restaurant. Deliberately a
 * client-only, localStorage-backed preference (like DateSystemProvider)
 * rather than a session-row field like `activeRestaurantId`: unlike
 * switching restaurants, picking a branch doesn't change which tenant's
 * data every API route resolves against — it only narrows a handful of
 * report queries — so there's no need for the server to know about it
 * between requests, and no migration to carry it.
 *
 * The storage key is namespaced per restaurant id so switching restaurants
 * never leaks a leftover branch selection from a different restaurant (branch
 * ids aren't even meaningful across restaurants). Re-derives from storage
 * whenever `restaurantId` or the `branches` list itself changes (e.g. the
 * restaurant switcher fired, or a branch got deactivated underneath a
 * stale selection) rather than trusting the previous state.
 */
export function BranchProvider({
  restaurantId,
  branches,
  children,
}: {
  restaurantId: string;
  branches: SelectableBranch[];
  children: ReactNode;
}) {
  const [activeBranchId, setActiveBranchIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(storageKey(restaurantId));
    return stored && branches.some((b) => b.id === stored) ? stored : null;
  });

  const branchIdsKey = branches.map((b) => b.id).join(",");
  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey(restaurantId));
    setActiveBranchIdState(stored && branches.some((b) => b.id === stored) ? stored : null);
    // branchIdsKey is a deliberate stand-in for `branches` itself (a new
    // array reference every render would otherwise re-run this on every
    // render, not just when the actual set of ids changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, branchIdsKey]);

  function setActiveBranchId(id: string | null) {
    setActiveBranchIdState(id);
    if (id) {
      window.localStorage.setItem(storageKey(restaurantId), id);
    } else {
      window.localStorage.removeItem(storageKey(restaurantId));
    }
  }

  return (
    <BranchContext.Provider value={{ branches, activeBranchId, setActiveBranchId }}>
      {children}
    </BranchContext.Provider>
  );
}

/**
 * Read (+ write) access to the active branch selection. Non-throwing
 * outside the provider — same philosophy as useDateSystem: a branch filter
 * is a display/query preference, not something worth crashing a stray
 * usage over. A caller outside the provider just sees "no branches, no
 * selection" (i.e. behaves as restaurant-wide/unfiltered).
 */
export function useActiveBranch(): BranchContextValue {
  const ctx = useContext(BranchContext);
  if (!ctx) {
    return { branches: [], activeBranchId: null, setActiveBranchId: () => {} };
  }
  return ctx;
}
