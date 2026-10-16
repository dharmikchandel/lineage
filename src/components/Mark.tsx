// The Lineage mark: an old claim branching into two newer versions, one carrying a debunk.
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 17.5C9 17.5 9 7 14 7M5 17.5c4.5 0 5.5 0 9 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <circle cx="5" cy="17.5" r="2.4" fill="currentColor" />
      <circle cx="16.5" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="17.5" r="2.4" fill="#ff6a3d" />
    </svg>
  );
}
