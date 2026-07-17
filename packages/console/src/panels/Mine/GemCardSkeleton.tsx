// Shimmer placeholder shaped like GemCard, shown while the grouped grid data loads.
// Reuses the same shimmer language as ScorecardHeroSkeleton (see Scorecard.tsx).
export function GemCardSkeleton() {
  return (
    <li className="gem-card gem-card--skeleton" aria-hidden="true">
      <div className="gem-card__top">
        <span className="gem-card__skel-icon" />
        <div className="gem-card__stack">
          <div className="gem-card__skel-line gem-card__skel-name" />
          <div className="gem-card__skel-line gem-card__skel-prov" />
        </div>
      </div>
      <div className="gem-card__badges">
        <div className="gem-card__skel-badge" />
      </div>
    </li>
  );
}
