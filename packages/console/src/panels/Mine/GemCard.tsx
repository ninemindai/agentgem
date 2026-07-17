import type { ReactNode } from "react";
import type { WorkflowCardModel } from "./groupWorkflows.js";

// The presentational gem card for the Mine grid. Callback-driven and data-free so it
// unit-tests without network; the parent (grid/data layer) supplies WorkflowCardModel
// and wires the callbacks to real actions. The score slot is reserved but never computed
// here — PR-1 always passes null/undefined (renders "Run hygiene →"); a later PR fills it.
export type GemScore = { value: number; tone: "good" | "warn"; label: string } | "running" | null;

export type GemCardProps = {
  card: WorkflowCardModel;
  score?: GemScore;
  expanded?: boolean;
  onRunHygiene: (card: WorkflowCardModel) => void;
  onOpen: (card: WorkflowCardModel) => void;
  onDistill: (card: WorkflowCardModel) => void;
  onShare: (card: WorkflowCardModel) => void;
  children?: ReactNode;
};

function ScoreSlot({ card, score, onRunHygiene }: Pick<GemCardProps, "card" | "score" | "onRunHygiene">) {
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
      <button type="button" className="gem-card__run" onClick={() => onRunHygiene(card)}>
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

export function GemCard({ card, score, expanded, onRunHygiene, onOpen, onDistill, onShare, children }: GemCardProps) {
  const provenance = card.sessions === 0
    ? `distilled · ${card.projectLabel}`
    : `distilled from ${card.sessions} session${card.sessions === 1 ? "" : "s"} · ${card.projectLabel}`;

  return (
    <li className="gem-card">
      <div className="gem-card__top">
        <span className="gem-card__icon" aria-hidden="true">🔁</span>
        <div className="gem-card__stack">
          <p className="gem-card__name" title={card.name}>{card.name}</p>
          <p className="gem-card__prov" title={provenance}>{provenance}</p>
        </div>
        <div className="gem-card__score-slot">
          <ScoreSlot card={card} score={score} onRunHygiene={onRunHygiene} />
        </div>
      </div>
      {(card.confidence === "high" || card.portable) && (
        <div className="gem-card__badges">
          {card.confidence === "high" && <span className="mine-badge mine-badge-bt">battle-tested</span>}
          {card.portable && <span className="mine-badge mine-badge-portable">portable</span>}
        </div>
      )}
      <div className="gem-card__acts">
        <button type="button" className="gem-card__act gem-card__act--primary" onClick={() => onOpen(card)}>Open</button>
        <button type="button" className="gem-card__act" onClick={() => onDistill(card)}>Distill → Gem</button>
        <button type="button" className="gem-card__act" onClick={() => onShare(card)}>Share</button>
      </div>
      {expanded && <div className="gem-card__detail">{children}</div>}
    </li>
  );
}
