import type { ReactNode } from "react";
import type { GemType, UnifiedGem } from "./unifiedGems.js";

// The presentational gem card for the Mine grid. Callback-driven and data-free so it
// unit-tests without network; the parent (grid/data layer) supplies UnifiedGem and wires
// the callbacks to real actions. The score slot is reserved but never computed here for
// scorable gems (renders "Run hygiene →" when score is null); a later PR fills it.
export type GemScore = { value: number; tone: "good" | "warn"; label: string } | "running" | null;

export type GemCardProps = {
  gem: UnifiedGem;
  score?: GemScore;
  expanded?: boolean;
  onRunHygiene: (gem: UnifiedGem) => void;
  onOpen: (gem: UnifiedGem) => void;
  onDistill: (gem: UnifiedGem) => void;
  onShare: (gem: UnifiedGem) => void;
  onPlay: (gem: UnifiedGem) => void;
  children?: ReactNode;
};

const TYPE_ICON: Record<GemType, string> = {
  workflow: "🔁",
  skill: "🧩",
  subagent: "🤖",
  lesson: "📝",
  rubric: "📐",
  miniapp: "🎮",
};

function ScoreSlot({ gem, score, onRunHygiene }: Pick<GemCardProps, "gem" | "score" | "onRunHygiene">) {
  if (score === "running") {
    return (
      <span className="warming-pill gem-card__rescoring">
        <span className="warming-pill__spark" aria-hidden="true">✦</span>
        …re-scoring
      </span>
    );
  }
  if (score == null) {
    return (
      <button type="button" className="gem-card__run" onClick={() => onRunHygiene(gem)}>
        Run hygiene →
      </button>
    );
  }
  return (
    <span className="gem-card__score-wrap">
      <span className={`gem-card__score gem-card__score--${score.tone}`}>{score.value}</span>
      <span className="gem-card__score-label">{score.label}</span>
    </span>
  );
}

function SignalSlot({ gem }: { gem: UnifiedGem }) {
  const { signal } = gem;
  if (signal.kind === "usage") {
    return <span className="gem-card__usage">{signal.invocations} use{signal.invocations === 1 ? "" : "s"}</span>;
  }
  if (signal.kind === "genre") {
    return <span className="mine-badge mine-badge-genre">{signal.genre}</span>;
  }
  return null;
}

function Actions({ gem, onOpen, onDistill, onShare, onPlay }: Pick<GemCardProps, "gem" | "onOpen" | "onDistill" | "onShare" | "onPlay">) {
  if (gem.type === "miniapp") {
    return (
      <div className="gem-card__acts">
        <button type="button" className="gem-card__act gem-card__act--primary" onClick={() => onPlay(gem)}>Play</button>
      </div>
    );
  }
  return (
    <div className="gem-card__acts">
      <button type="button" className="gem-card__act gem-card__act--primary" onClick={() => onOpen(gem)}>Open</button>
      {gem.type === "workflow" && (
        <>
          <button type="button" className="gem-card__act" onClick={() => onDistill(gem)}>Distill → Gem</button>
          <button type="button" className="gem-card__act" onClick={() => onShare(gem)}>Share</button>
        </>
      )}
    </div>
  );
}

export function GemCard({ gem, score, expanded, onRunHygiene, onOpen, onDistill, onShare, onPlay, children }: GemCardProps) {
  const showBattleTestedBadges = gem.signal.kind === "confidence";
  const showSharedBadge = gem.maturity === "shared";
  const hasBadges = showBattleTestedBadges || showSharedBadge;

  return (
    <li className="gem-card">
      <div className="gem-card__top">
        <span className="gem-card__icon" aria-hidden="true">{TYPE_ICON[gem.type]}</span>
        <div className="gem-card__stack">
          <p className="gem-card__name" title={gem.name}>{gem.name}</p>
          <p className="gem-card__prov" title={gem.provenance}>{gem.provenance}</p>
        </div>
        <div className="gem-card__score-slot">
          {gem.scorable ? (
            <ScoreSlot gem={gem} score={score} onRunHygiene={onRunHygiene} />
          ) : (
            <SignalSlot gem={gem} />
          )}
        </div>
      </div>
      {hasBadges && (
        <div className="gem-card__badges">
          {showBattleTestedBadges && gem.signal.kind === "confidence" && (
            <>
              {gem.signal.confidence === "high" && <span className="mine-badge mine-badge-bt">battle-tested</span>}
              {gem.signal.portable && <span className="mine-badge mine-badge-portable">portable</span>}
            </>
          )}
          {showSharedBadge && <span className="mine-badge mine-badge-shared">shared</span>}
        </div>
      )}
      <Actions gem={gem} onOpen={onOpen} onDistill={onDistill} onShare={onShare} onPlay={onPlay} />
      {expanded && <div className="gem-card__detail">{children}</div>}
    </li>
  );
}
