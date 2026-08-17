// RestroMitra's brand mark — the studio-designed circular badge (chef's hat
// "Design", the covered dish "Service & Hospitality", the fork "Food &
// Dining", the handshake "Mitra/Partnership" — see public/brand for the
// full mark rationale) supplied as the official logo. This replaced an
// earlier hand-coded SVG placeholder once the real mark was ready; it's a
// raster asset now, so `LogoMark` just sizes and positions it rather than
// drawing it, and every call site keeps working unchanged since the
// `className`-sizing API didn't change.
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a static brand
    // asset served from /public, not a per-tenant or build-time-known image
    // next/image would meaningfully optimize.
    <img
      src="/brand/icon-256.png"
      alt=""
      className={`${className} shrink-0 rounded-full object-contain transition-transform duration-500 ease-out group-hover:rotate-6 group-hover:scale-105`}
    />
  );
}
