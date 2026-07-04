import { useEffect, useState } from "react";
import { rubricsRoute, makeClient, type RubricSummary } from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";
import { setPendingRubric } from "../../pendingAnalyze.js";
import { Loading } from "../../shell/Loading.js";

function isCheap(r: RubricSummary): boolean {
  return !r.criteria || r.criteria.length === 0;
}

// Group rubrics by the scope they're designed for, so the catalog reads as
// "session lenses / project lenses / corpus lenses" (design §5c).
const SCOPE_GROUPS: { key: string; label: string; match: (r: RubricSummary) => boolean }[] = [
  { key: "session", label: "Session lenses", match: (r) => r.naturalScope === "session" },
  { key: "project", label: "Project lenses", match: (r) => r.naturalScope === "project" },
  { key: "all", label: "Corpus lenses", match: (r) => r.naturalScope === "all" },
  { key: "other", label: "Other", match: (r) => !r.naturalScope },
];

function runRubric(id: string): void {
  setPendingRubric(id);
  window.location.hash = "#/rubrics";
}

function RubricRow({ r }: { r: RubricSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="analyze-row">
      <div className="analyze-row-head">
        <button type="button" className="rub-lib-name" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="rub-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="analyze-name">{r.title}</span>
        </button>
        <span className="targets-label">{r.factors.length} factor{r.factors.length === 1 ? "" : "s"}</span>
        <span className="ws-chip" title={isCheap(r) ? "Runs pattern checks — instant, deterministic" : "Uses LLM criteria (Phase 2)"}>{isCheap(r) ? "cheap" : "LLM"}</span>
        <button type="button" className="ledger-view" onClick={() => runRubric(r.id)}>Run ▶</button>
      </div>
      {open && (
        <div className="run-out">
          <ul className="rub-lib-factors">
            {r.factors.map((f) => <li key={f.factor}><code>{f.factor}</code>{f.weight != null && f.weight !== 1 ? ` ×${f.weight}` : ""}</li>)}
          </ul>
          {r.criteria && r.criteria.length > 0 && (
            <p className="ledger-muted">{r.criteria.length} LLM criterion{r.criteria.length === 1 ? "" : "a"} — evaluated in Phase 2.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** Rubrics catalog: browse the lenses you can run (built-in + your own), grouped
 *  by the scope they're designed for. Authoring is by JSON files in
 *  ~/.agentgem/rubrics/ for now (in-console editor is the next step). */
export function RubricLibrary({ apiBase }: { apiBase: string }) {
  const [rubrics, setRubrics] = useState<RubricSummary[] | null>(null);

  useEffect(() => {
    rubricsRoute.call(makeClient(apiBase)).then((r) => setRubrics(r.rubrics)).catch(() => setRubrics([]));
  }, [apiBase]);

  if (!rubrics) return <section className="analyze"><Loading /></section>;

  return (
    <section className="analyze">
      <p className="analyze-intro">Rubrics are named lenses of checks you can run over your sessions. Built-ins work out of the box; add your own as JSON in <code>~/.agentgem/rubrics/</code>.</p>
      {rubrics.length === 0 ? (
        <p className="ledger-empty">No rubrics found.</p>
      ) : (
        SCOPE_GROUPS.map((g) => {
          const items = rubrics.filter(g.match);
          if (items.length === 0) return null;
          return (
            <div className="rub-lib-group" key={g.key}>
              <h4 className="rub-lib-heading">{g.label}</h4>
              <ul className="analyze-list">
                {items.map((r) => <RubricRow key={r.id} r={r} />)}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

export const rubricLibraryPage = defineConsolePage({
  id: "rubric-library", title: "Rubrics", icon: "📋", order: 26, group: "library",
  route: "#/rubric-library", component: RubricLibrary,
});
