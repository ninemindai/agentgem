// packages/console/src/shell/RefreshButton.tsx
// A small icon button that forces a fresh scan past the 15s server cache. Spins
// its circular-arrow glyph while `busy`, and is disabled so the user can't stack
// re-scans. Shared by the cache-backed panels (Inspect, Optimize, Mine).

export function RefreshButton({
  onClick,
  busy = false,
  title = "Refresh — force a fresh scan",
}: {
  onClick: () => void;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={"refresh-btn" + (busy ? " is-busy" : "")}
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
        <path d="M20 11.5a8 8 0 1 0-.92 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M20 4.5v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
