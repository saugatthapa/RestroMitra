// Vitest runs in plain Node, which resolves the real "server-only" package
// to a module that unconditionally throws (it's meant to be caught by
// Next's bundler via the "react-server" export condition instead). This
// stub is aliased in vitest.config.ts so modules importing "server-only"
// can still be loaded under test.
export {};
