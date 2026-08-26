"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Phase 22 (offline mode) — a shared browser online/offline hook, extracted
 * from POSOrderBuilder.tsx's own inline isOnline state (Phase 11b) so
 * OrdersBoard and KDSBoard can share the exact same detection instead of
 * each re-inventing it, rather than a behavior change: POSOrderBuilder is
 * switched to use this too, with the same lazy-initializer + online/offline
 * listener logic it already had.
 *
 * `onReconnect` fires once, right after the browser reports "online" again
 * — the natural moment to kick off a queued-mutation sync without staff
 * having to remember a manual "Sync now" click. Held in a ref (not a
 * useEffect dependency) so passing a fresh closure on every render — the
 * common case, since it usually closes over other state — never tears down
 * and re-attaches the window listeners.
 *
 * QA hardening pass (offline-POS audit) — `onReconnect` also fires once on
 * mount when the browser is ALREADY online. The gap this closes: a device
 * goes offline, queues some orders, and the tab/app is closed; by the time
 * it's reopened, connectivity is already back — the browser's `online`
 * event only fires on an offline→online TRANSITION, so a mount that starts
 * already-online never sees one, and the queue would otherwise sit
 * unsynced until some other transition happened to occur. Nothing is lost
 * (the queue persists in IndexedDB regardless), it just wouldn't
 * auto-flush. Every real call site's `onReconnect` (runSync in
 * POSOrderBuilder/OrdersBoard/KDSBoard) is idempotent/cheap to call
 * redundantly — it bails out immediately if already syncing or the queue
 * is empty — so firing it unconditionally on an already-online mount is
 * safe.
 */
/**
 * Pure decision extracted from the mount effect below purely so it's
 * unit-testable without a DOM/React renderer — this codebase has no React
 * component/hook test infrastructure (vitest.config.mts runs with
 * `environment: "node"`, no jsdom/happy-dom), and adding one just for this
 * one hook would be disproportionate to the fix. Mirrors the exact
 * condition the effect uses.
 */
export function isBrowserOnlineNow(nav: Pick<Navigator, "onLine"> | undefined): boolean {
  return typeof nav !== "undefined" && nav.onLine === true;
}

export function useOnlineStatus(onReconnect?: () => void): boolean {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    function goOnline() {
      setIsOnline(true);
      onReconnectRef.current?.();
    }
    function goOffline() {
      setIsOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    if (isBrowserOnlineNow(typeof navigator === "undefined" ? undefined : navigator)) {
      onReconnectRef.current?.();
    }
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}
