import { describe, it, expect } from "vitest";
import { isBrowserOnlineNow } from "./use-online-status";

// QA hardening pass (offline-POS audit) — regression test for the bug
// where a device that goes offline, queues orders, and has its tab/app
// closed and reopened AFTER connectivity is already restored would never
// auto-sync: the browser's "online" event only fires on an offline→online
// TRANSITION, which never happens if the app mounts already-online. This
// covers the pure decision useOnlineStatus's mount effect uses to decide
// whether to fire onReconnect() immediately — see that file's own comment
// for why a full hook-render test isn't used (no React test infra in this
// codebase).
describe("isBrowserOnlineNow", () => {
  it("returns true when navigator.onLine is true", () => {
    expect(isBrowserOnlineNow({ onLine: true })).toBe(true);
  });

  it("returns false when navigator.onLine is false", () => {
    expect(isBrowserOnlineNow({ onLine: false })).toBe(false);
  });

  it("returns false when navigator is undefined (SSR / no window)", () => {
    expect(isBrowserOnlineNow(undefined)).toBe(false);
  });
});
