// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { timeAgo } from "../../util/timeAgo.js";
import type { MomentHit } from "../../api/routes.js";

/** The server wraps matched terms in ⌈…⌉ inside the snippet; split on the markers
 *  and render the enclosed (odd-indexed) segments as <mark>. */
function renderSnippet(snippet: string): ReactNode[] {
  return snippet.split(/[⌈⌉]/).map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>);
}

export function selectionKey(hit: Pick<MomentHit, "agent" | "sessionId">): string {
  return `${hit.agent}:${hit.sessionId}`;
}

/** One cross-session moment: project/branch/agent/when, the highlighted snippet, a
 *  turn-level deep link (received by Task 5's #/sessions ?turn= handler), and the
 *  matching-turns count. The whole card is the selection toggle (mirrors the mockup);
 *  the "Open turn" link stops propagation so it navigates without also toggling. */
export function MomentCard({ hit, picked, onToggle }: {
  hit: MomentHit; picked: boolean; onToggle: (key: string) => void;
}) {
  const key = selectionKey(hit);
  const openHref = `#/sessions/${hit.agent}/${encodeURIComponent(hit.sessionId)}?turn=${hit.turn}`;
  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      className={"rc-moment" + (picked ? " is-picked" : "")}
      onClick={() => onToggle(key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(key); }
      }}
    >
      <span className="rc-check" aria-hidden="true">{picked ? "✓" : ""}</span>
      <div className="rc-moment-body">
        <div className="rc-moment-top">
          <span className="rc-proj">{hit.project ?? "—"}</span>
          <span className="rc-dot" />
          <span className="rc-branch">{hit.branch ?? "—"}</span>
          <span className="rc-agent">{hit.agent}</span>
          <span className="rc-when">{timeAgo(hit.startMs)}</span>
        </div>
        <div className="rc-snip">{renderSnippet(hit.snippet)}</div>
        <div className="rc-moment-foot">
          <a className="rc-openlink" href={openHref} onClick={(e) => e.stopPropagation()}>Open turn ↗</a>
          <span className="rc-hits">{hit.turnsMatched} matching {hit.turnsMatched === 1 ? "turn" : "turns"}</span>
        </div>
      </div>
    </li>
  );
}
