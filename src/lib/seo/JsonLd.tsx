/**
 * Renders one JSON-LD <script> block. `data` should come from one of the
 * builders in json-ld.ts (or an object/array of several combined) — kept
 * as a single tiny component so every page emits structured data the same
 * way rather than hand-rolling `dangerouslySetInnerHTML` per call site.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    // JSON.stringify of a plain-object schema.org payload we built
    // ourselves; nothing here is user-supplied HTML.
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
