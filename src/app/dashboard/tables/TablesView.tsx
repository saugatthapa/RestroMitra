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
export function TablesView({ slug }: { slug: string }) {
  const [view, setView] = useState<"floor" | "list">("floor");

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-full bg-neutral-100 p-1 text-sm">
        <button
          onClick={() => setView("floor")}
          className={`rounded-full px-4 py-1.5 font-medium ${
            view === "floor" ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500"
          }`}
        >
          Floor plan
        </button>
        <button
          onClick={() => setView("list")}
          className={`rounded-full px-4 py-1.5 font-medium ${
            view === "list" ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500"
          }`}
        >
          List &amp; QR codes
        </button>
      </div>

      {view === "floor" ? <FloorPlanBoard slug={slug} /> : <TablesManager slug={slug} />}
    </div>
  );
}
