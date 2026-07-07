import type { CSSProperties } from "react";

export interface SessionActivity {
  tools: Record<string, number>;
  skills: Record<string, number>;
  subagents: Record<string, number>;
}

/** Deterministic one-line activity skeleton for a session's hover summary: the
 *  top-5 tools by invocation count (tie-break name asc) as `Name×N`, then the
 *  DISTINCT skill and subagent counts. All-empty maps → []. Pure; no fetching. */
export function formatActivity(a: SessionActivity): string[] {
  const parts = Object.entries(a.tools)
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 5)
    .map(([name, n]) => `${name}×${n}`);
  const nSkills = Object.keys(a.skills).length;
  if (nSkills > 0) parts.push(`${nSkills} skill${nSkills === 1 ? "" : "s"}`);
  const nSubs = Object.keys(a.subagents).length;
  if (nSubs > 0) parts.push(`${nSubs} subagent${nSubs === 1 ? "" : "s"}`);
  return parts;
}

// Anchored under the row's project cell (which is position:relative). Themed via
// existing CSS variables so it works in both light and dark without a theme.css edit.
const POP_BASE: CSSProperties = {
  position: "absolute", left: 12, zIndex: 20,
  maxWidth: 460, whiteSpace: "normal",
  background: "var(--raised)", border: "1px solid var(--line)",
  borderRadius: "var(--radius)", boxShadow: "var(--shadow-md)",
  padding: "6px 10px", font: "11.5px/1.5 var(--font-ui)", color: "var(--ink-soft)",
};
// Default anchors below the row; `up` anchors above it so the popover on the
// last row isn't clipped by the table wrapper's overflow.
const POP_DOWN: CSSProperties = { ...POP_BASE, top: "100%", marginTop: 4 };
const POP_UP: CSSProperties = { ...POP_BASE, bottom: "100%", marginBottom: 4 };

/** Hover/focus popover showing a session's activity skeleton. */
export function SessionSummaryPopover({ activity, up = false }: { activity: SessionActivity; up?: boolean }) {
  const parts = formatActivity(activity);
  return (
    <div className="obs-summary-pop" role="tooltip" style={up ? POP_UP : POP_DOWN}>
      {parts.length === 0
        ? <span className="obs-muted">No recorded tool activity</span>
        : parts.join(" · ")}
    </div>
  );
}
