"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Segmented Sign In / Start free trial switcher above the login and
 * register cards. Plain navigation (Link, not client-side tab state) since
 * login and register are two real routes with two real forms — this just
 * makes hopping between them a single click instead of scrolling to the
 * "New here? / Already have an account?" line at the bottom.
 */
export function AuthTabs() {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  return (
    <div className="mb-6 flex rounded-full border border-hairline bg-surface-1 p-1 text-sm font-medium">
      <Link
        href="/login"
        className={`flex-1 rounded-full px-4 py-2 text-center transition ${
          isLogin ? "bg-surface-2 text-ink shadow-sm" : "text-ink-muted hover:text-ink-secondary"
        }`}
      >
        Sign in
      </Link>
      <Link
        href="/register"
        className={`flex-1 rounded-full px-4 py-2 text-center transition ${
          !isLogin ? "bg-surface-2 text-ink shadow-sm" : "text-ink-muted hover:text-ink-secondary"
        }`}
      >
        Start free trial
      </Link>
    </div>
  );
}
