// The Lineage mark: an old claim branching into two newer versions, one carrying a debunk.
// One geometry for every place the mark appears: the top bar (below) and the browser-tab
// icons (src/app/icon.tsx, src/app/apple-icon.tsx), so the two can never drift apart.
const BRANCH = "M5 17.5C9 17.5 9 7 14 7M5 17.5c4.5 0 5.5 0 9 0";
const EMBER = "#f0784e";

export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={BRANCH} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <circle cx="5" cy="17.5" r="2.4" fill="currentColor" />
      <circle cx="16.5" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="17.5" r="2.4" fill={EMBER} />
    </svg>
  );
}

/**
 * The mark as a standalone SVG document for tab icons. A tab bar may be light or dark and
 * cannot inherit currentColor, so the mark sits on the app's own dark tile in its text color.
 * The translate centres the mark's bounds (x 2.6-18.9, y 4.6-19.9) on the tile.
 */
export function markIconSvg(): string {
  const ink = "#ececee";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
<rect width="24" height="24" rx="5.5" fill="#08090a"/>
<g transform="translate(1.25 -0.25)">
<path d="${BRANCH}" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
<circle cx="5" cy="17.5" r="2.4" fill="${ink}"/>
<circle cx="16.5" cy="7" r="2.4" stroke="${ink}" stroke-width="1.6"/>
<circle cx="16.5" cy="17.5" r="2.4" fill="${EMBER}"/>
</g>
</svg>`;
}
