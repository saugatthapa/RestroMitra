import type { NextConfig } from "next";

// Next 16's static-page generation crashes non-deterministically with
// "Cannot read properties of null (reading 'useContext')" while
// prerendering — an open upstream bug (vercel/next.js#95741, #86178,
// #84994) traced to a race in Next's own AppRouterContext plumbing that
// only shows up with more than one static-generation worker running
// concurrently.
//
// `experimental.cpus` is what controls that worker count, and Next
// defaults it to `os.cpus().length - 1` (see
// node_modules/next/dist/server/config-shared.js) — i.e. it's silently
// picked by whatever machine happens to run the build. That's exactly why
// this built clean in dev/CI here (a 2-CPU box → 1 worker, no race
// possible) and then crashed on Netlify's build machine (more CPUs → 2+
// workers → the race triggers). Pinning it to 1 forces the same
// single-worker, race-free path everywhere, regardless of host.
//
// --webpack (see the build script in package.json) is kept alongside this
// as a second, independent mitigation, since one upstream report also
// pointed at Turbopack-specific chunk batching as a contributing factor.
// Safe to revisit both once the upstream issue is closed.
const nextConfig: NextConfig = {
  experimental: {
    cpus: 1,
  },
};

export default nextConfig;
