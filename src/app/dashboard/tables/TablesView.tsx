"use client";

import { useState } from "react";
import { TablesManager } from "./TablesManager";
import { FloorPlanBoard } from "./FloorPlanBoard";

/**
 * Phase 12b: the floor plan is additive, not a replacement — TablesManager
 * (QR codes, rename, deactivate) keeps working exactly as before. This just
 * adds a second view onto the same tables, toggled with a tab, rather than
 * duplicating the tables page.
 */
export function TablesView({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const [view, setView] = useState<"floor" | "list">("floor");

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-full bg-surface-1 p-1 text-sm">
        <button
          onClick={() => setView("floor")}
          className={`rounded-full px-4 py-1.5 font-medium ${
            view === "floor" ? "bg-surface-2 text-ink shadow-sm" : "text-ink-muted"
          }`}
        >
          Floor plan
        </button>
        <button
          onClick={() => setView("list")}
          className={`rounded-full px-4 py-1.5 font-medium ${
            view === "list" ? "bg-surface-2 text-ink shadow-sm" : "text-ink-muted"
          }`}
        >
          List &amp; QR codes
        </button>
      </div>

      {view === "floor" ? (
        <FloorPlanBoard slug={slug} />
      ) : (
        <TablesManager slug={slug} restaurantName={restaurantName} />
      )}
    </div>
  );
}
