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
 */
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
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}
