import type { AggIngredient } from "../../api/routes.js";
import { prettifyId, kindLabel, verifiedShare, barWidths } from "./data.js";

// Tools-only (product decision): Insights ranks shareable ingredients — skills + MCPs.
// "All" maps to no `kind` param, which the backend popularity() defaults to skill+mcp.
const KINDS: { value: string; label: string }[] = [
  { value: "all", label: "All" }, { value: "skill", label: "Skill" }, { value: "mcp", label: "MCP" },
];

export function Leaderboard({ rows, kind, onKind, selectedId, onSelect }: {
  rows: AggIngredient[]; kind: string; onKind: (k: string) => void;
  selectedId: string | null; onSelect: (id: string) => void;
}) {
  const widths = barWidths(rows.map((r) => r.producers));
  return (
    <div className="ins-board">
      <div className="ins-tabs">
        {KINDS.map((k) => (
          <button key={k.value} type="button"
            className={"ins-tab" + (k.value === kind ? " is-active" : "")}
            onClick={() => onKind(k.value)}>{k.label}</button>
        ))}
      </div>
      {rows.length === 0 && <div className="ins-empty">No ingredients above the k-anonymity floor yet.</div>}
      <ol className="ins-rows">
        {rows.map((r, i) => {
          const p = prettifyId(r.id, r.kind);
          return (
            <li key={r.id}>
              <button type="button"
                className={"ins-row" + (r.id === selectedId ? " is-active" : "")}
                onClick={() => onSelect(r.id)}>
                <span className="ins-rank">{i + 1}</span>
                <span className="ins-name">{p.name}{p.scope && <span className="ins-scope">{p.scope}</span>}</span>
                <span className="ins-kind">{kindLabel(r.kind)}</span>
                <span className="ins-bar"><span className="ins-bar-fill" style={{ width: `${(widths[i] * 100).toFixed(0)}%` }} /></span>
                <span className="ins-counts">
                  {r.producers} producers
                  <span className="ins-verified" title="GitHub-bound, signature-verified producers"> · {r.verifiedProducers} verified ✓</span>
                </span>
                <span className="ins-vshare"><span className="ins-vshare-fill" style={{ width: `${(verifiedShare(r.producers, r.verifiedProducers) * 100).toFixed(0)}%` }} /></span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
