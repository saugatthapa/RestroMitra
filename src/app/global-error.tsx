"use client";

/**
 * Root-level error boundary — catches anything an error.tsx further down
 * the tree didn't (including errors in the root layout itself). Without
 * this file, Next.js auto-generates its own default global-error page —
 * and that auto-generated page is what was crashing the Netlify build
 * (see next.config.ts's comment on experimental.cpus for the full
 * investigation). Providing our own removes Next's default from the
 * picture entirely: deliberately minimal, no imports beyond React, no
 * Tailwind classes (per Next's docs, global-error renders its own
 * document and the app's compiled CSS isn't guaranteed to be loaded here),
 * just inline styles in the brand color.
 *
 * Must be a Client Component and must render its own <html>/<body> — this
 * fully replaces the root layout when it activates. `retry` is this Next
 * version's prop name (older Next docs call it `reset`).
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
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
            onClick={() => retry()}
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
