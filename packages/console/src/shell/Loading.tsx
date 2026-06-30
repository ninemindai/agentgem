// packages/console/src/shell/Loading.tsx
// The shared wait state: the AgentGem facet mark catching the light while it
// loads. A faint static rim keeps the gem legible; a short "glint" dash travels
// the rim (stroke-dashoffset over pathLength=100, so the loop is seamless), the
// facets breathe, and the whole mark floats. The global prefers-reduced-motion
// reset in theme.css freezes all of it while leaving the gem fully drawn.

const GEM = "M6 3h12l4 6-10 12L2 9l4-6Z";
const FACETS = "M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="gem-loading" role="status" aria-live="polite" aria-busy="true">
      <svg className="gem-loading__mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path className="gem-loading__fill" d={GEM} />
        <path className="gem-loading__facets" d={FACETS} />
        <path className="gem-loading__rim" d={GEM} />
        <path className="gem-loading__glint" d={GEM} pathLength={100} />
      </svg>
      <span className="gem-loading__label">{label}</span>
    </div>
  );
}
