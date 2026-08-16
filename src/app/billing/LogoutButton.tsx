"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiPost } from "@/lib/api-client";

export function LogoutButton() {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiPost("/api/auth/logout", {});
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button onClick={handleLogout} disabled={loggingOut} className="btn-secondary">
      {loggingOut ? "Logging out…" : "Log out"}
    </button>
  );
}
