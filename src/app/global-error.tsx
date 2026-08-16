"use client";

/**
 * Root-level error boundary — catches anything an error.tsx further down
 * the tree didn't (including errors in the root layout itself). Without
 * this file, Next.js auto-generates its own default global-error page.
 * On Next 16 that auto-generated page was crashing the Netlify build
 * outright (see the README's "Deploying to Netlify" section for the full
 * investigation, which is ultimately why this app is pinned to Next 15).
 * Kept even after the downgrade since every production Next app should
 * have one: deliberately minimal, no imports beyond React, no Tailwind
 * classes (per Next's docs, global-error renders its own document and the
 * app's compiled CSS isn't guaranteed to be loaded here), just inline
 * styles in the brand color.
 *
 * Must be a Client Component and must render its own <html>/<body> — this
 * fully replaces the root layout when it activates. `reset` is Next 15's
 * prop name (Next 16 renamed it to `retry`).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          backgroundColor: "#fafafa",
          color: "#171717",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: 420 }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: "0.9rem", color: "#737373", marginBottom: "1.5rem" }}>
            An unexpected error occurred.
            {error.digest && (
              <>
                <br />
                Reference: {error.digest}
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              backgroundColor: "#ea580c",
              color: "#fff",
              border: "none",
              borderRadius: "9999px",
              padding: "0.625rem 1.5rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
