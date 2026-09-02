"use client";

import { useEffect, useState } from "react";

const DISMISSED_KEY = "restromitra:install-prompt-dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandaloneAlready(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * Phase 22 (offline mode / installable app) — a small "Install app" button
 * for the dashboard header, next to the language/date toggles. Two
 * completely different install paths, because the two mobile platforms
 * don't offer the same API:
 *
 * - Chrome/Edge (desktop and Android) fire a `beforeinstallprompt` event
 *   this component captures and defers; clicking the button replays it via
 *   `.prompt()`, which shows the browser's own native install confirmation.
 * - iOS Safari has NO equivalent event or programmatic install trigger at
 *   all — Add to Home Screen only exists behind the manual Share sheet.
 *   For iOS the button instead opens a small instructional popover
 *   ("Tap Share, then Add to Home Screen") rather than pretending to
 *   install anything itself.
 *
 * Renders nothing once the app is already running standalone (installed),
 * or after the staff member has dismissed it once — this is a one-time
 * nudge, not a recurring nag on every login.
 */
export function InstallAppPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosTip, setShowIosTip] = useState(false);
  const [dismissed, setDismissed] = useState(true); // default hidden until effects settle, avoids a flash
  const [platform, setPlatform] = useState<"android" | "ios" | "none">("none");

  useEffect(() => {
    if (isStandaloneAlready()) return;
    setDismissed(window.localStorage.getItem(DISMISSED_KEY) === "1");
    setPlatform(isIos() ? "ios" : "none"); // "android"/desktop confirmed only once beforeinstallprompt actually fires

    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setPlatform("android");
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  function dismiss() {
    setDismissed(true);
    setShowIosTip(false);
    window.localStorage.setItem(DISMISSED_KEY, "1");
  }

  async function handleClick() {
    if (platform === "ios") {
      setShowIosTip((v) => !v);
      return;
    }
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    // Either accepted (now installing) or dismissed the native dialog —
    // either way the same deferred event can't be replayed, and re-nagging
    // right after someone said no is exactly the annoying-app-prompt
    // pattern this is trying to avoid.
    setDeferredPrompt(null);
    dismiss();
  }

  if (dismissed || platform === "none") return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        aria-label="Install app"
        className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-1 sm:px-3"
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <path d="M7 10l5 5 5-5" />
            <path d="M5 19h14" />
          </svg>
        </span>
        <span className="hidden sm:inline">Install app</span>
      </button>

      {showIosTip && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-hairline bg-surface-2 p-3 text-xs text-ink-secondary shadow-lg">
          <p className="font-semibold text-ink">Add RestroKendra to your Home Screen</p>
          <p className="mt-1">
            Tap the Share icon in Safari, then choose <span className="font-medium">Add to Home Screen</span>.
            It&apos;ll open full-screen, just like an app.
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="mt-2 rounded-full border border-hairline px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:bg-surface-1"
          >
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
