import type { NextConfig } from "next";

// `npm run build` passes --webpack (see package.json) rather than letting
// Next 16 default to Turbopack for production builds. Turbopack's static
// page generation has an open upstream bug where it non-deterministically
// crashes prerendering with "Cannot read properties of null (reading
// 'useContext')" — worker-count-dependent, so it can pass locally and still
// fail on a CI host with different concurrency (this is exactly what
// happened on Netlify: https://github.com/vercel/next.js/issues/95741,
// https://github.com/vercel/next.js/issues/86178). `next dev` still uses
// Turbopack (unaffected, faster) — this only forces webpack for the
// production build step. Safe to try dropping --webpack again once that
// upstream issue is closed.
const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
