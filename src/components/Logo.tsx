// RestroMitra's brand mark — a rounded badge with a bold, stroke-drawn "R"
// (matching the app's existing icon convention: currentColor, round caps/
// joins) plus a small dot standing in for "Mitra" (friend/companion) — the
// platform's AI assistant and always-there-for-you positioning, not just a
// generic monogram. Deliberately vector, not a raster image: crisp at a
// 20px sidebar badge and a 512px app-icon alike, no asset pipeline, and it
// recolors for free if the brand palette ever shifts (it just reads
// `currentColor` off the badge background's `text-*` class).
//
// Shared here rather than redefined per file (the old DhankiPOS mark was
// only ever used inside src/app/page.tsx, so it never needed extracting)
// since the redesign now uses it from the marketing page and the auth
// layout both.
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <span
      className={`flex ${className} shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-700 text-white shadow-sm transition-transform duration-500 ease-out group-hover:rotate-6 group-hover:scale-105`}
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-[58%] w-[58%]">
        <path
          d="M7 19V5h5.5a3.5 3.5 0 0 1 0 7H7m4 0 6 7"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="18.3" cy="5.7" r="1.5" fill="currentColor" />
      </svg>
    </span>
  );
}
